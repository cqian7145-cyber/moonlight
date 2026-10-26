import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { hashToken } from "./tokens";
import { createPlayGroupApiHandlers } from "./play-group-api";
import { createAttemptApiHandlers } from "./attempt-api";

const baseUrl = "https://moonlight.test";
const cues = [
  { key: "q1", prompt: "选择一", choices: ["甲", "乙", "丙"] },
  { key: "q2", prompt: "选择二", choices: ["甲", "乙", "丙"] },
  { key: "q3", prompt: "选择三", choices: ["甲", "乙", "丙"] },
];
const content = { cues, answerKey: [2, 2, 2], hiddenExplanation: "不得通过顾客 API 暴露" };

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let handlers: ReturnType<typeof createPlayGroupApiHandlers>;

async function fixture(venueStatus: "active" | "suspended" = "active") {
  const tableCode = randomBytes(32).toString("base64url");
  const [venue] = await db.insert(schema.venues).values({ name: "月光虚构小馆", status: venueStatus }).returning();
  const [table] = await db.insert(schema.venueTables).values({ venueId: venue.id, name: "桌 1", publicCodeHash: hashToken(tableCode) }).returning();
  const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue.id, title: "今晚的微醺灵感" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId: venue.id, templateId: template.id, versionNo: 1, content }).returning();
  const [publication] = await db.insert(schema.publications).values({ venueId: venue.id, versionId: version.id, activatedAt: new Date(Date.now() - 60_000) }).returning();
  return { tableCode, venue, table, publication };
}

function request(method: "GET" | "POST", path: string, options: { body?: unknown; cookie?: string; origin?: string | null; contentType?: string } = {}) {
  const headers = new Headers({ host: new URL(baseUrl).host });
  if (options.body !== undefined) headers.set("content-type", options.contentType ?? "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin !== null) headers.set("origin", options.origin ?? baseUrl);
  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
}

function cookieFrom(response: Response) {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

async function createRoom(tableCode: string) {
  return handlers.create(request("POST", "/api/play-groups", { body: { tableCode, consent: true } }));
}

async function answer(cookie: string, cueKey: string, optionIndex: number) {
  return handlers.answer(request("POST", "/api/play-groups/answer", { cookie, body: { cueKey, optionIndex } }));
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  handlers = createPlayGroupApiHandlers({ databaseProvider: () => db });
});

afterEach(async () => client.close());

describe("two-person HTTP handlers backed by the checked-in SQL migration", () => {
  it("creates only after same-origin consent, scopes an independent hardened cookie, and leaves GET side-effect free", async () => {
    const entry = await fixture();
    const denied = await handlers.create(request("POST", "/api/play-groups", { body: { tableCode: entry.tableCode, consent: true }, origin: "https://attacker.example" }));
    expect(denied.status).toBe(403);
    const noConsent = await handlers.create(request("POST", "/api/play-groups", { body: { tableCode: entry.tableCode, consent: false } }));
    expect(noConsent.status).toBe(400);
    expect(await db.select().from(schema.playGroups)).toHaveLength(0);

    const created = await createRoom(entry.tableCode);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({ status: "created", invitationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/participantToken|attemptId|groupId|venueId|sessionTokenHash|inviteCodeHash/);
    const cookie = cookieFrom(created);
    const header = created.headers.get("set-cookie")!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/api\/play-groups/i);
    expect(header).toMatch(/Max-Age=89\d/i);
    expect(created.headers.get("cache-control")).toMatch(/no-store/i);
    expect(header).not.toContain(body.invitationToken);

    const [group] = await db.select().from(schema.playGroups);
    const [attempt] = await db.select().from(schema.attempts);
    expect(group?.inviteCodeHash).toBe(hashToken(body.invitationToken));
    expect(attempt?.sessionTokenHash).not.toBe(cookie.split("=")[1]);
    expect(attempt?.consentedAt).toBeInstanceOf(Date);
    expect(attempt?.mode).toBe("duo");
    const resumed = await handlers.create(request("POST", "/api/play-groups", { body: { tableCode: entry.tableCode, consent: true }, cookie }));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: "resumed" });
    expect(resumed.headers.get("set-cookie")).toBeNull();
    const solo = createAttemptApiHandlers({ databaseProvider: () => db });
    const soloView = await solo.current(new Request(`${baseUrl}/api/attempts/current?tableCode=${encodeURIComponent(entry.tableCode)}`, { headers: { cookie } }));
    expect(soloView.status).toBe(401);
    expect(await handlers.current(request("GET", "/api/play-groups/current"))).toMatchObject({ status: 401 });
    expect(await db.select().from(schema.playGroups)).toHaveLength(1);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
  });

  it("previews without writing, requires B consent, isolates members, and reveals one safe shared result only after both complete", async () => {
    const entry = await fixture();
    const created = await createRoom(entry.tableCode);
    const hostCookie = cookieFrom(created);
    const { invitationToken } = await created.json();
    const preview = await handlers.preview(request("POST", "/api/play-groups/invitation", { body: { invitationToken } }));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ venueName: "月光虚构小馆", activityTitle: "今晚的微醺灵感" });
    expect(await db.select().from(schema.attempts)).toHaveLength(1);

    const refused = await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: false } }));
    expect(refused.status).toBe(400);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
    const joined = await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true } }));
    expect(joined.status).toBe(201);
    const guestCookie = cookieFrom(joined);
    expect(guestCookie).not.toBe(hostCookie);
    expect(joined.headers.get("set-cookie")).toMatch(/Path=\/api\/play-groups/i);
    expect((await db.select().from(schema.attempts).where(eq(schema.attempts.mode, "duo")))).toHaveLength(2);

    const hostQuestions = await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: hostCookie }));
    const guestQuestions = await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: guestCookie }));
    expect(hostQuestions.status).toBe(200);
    expect(guestQuestions.status).toBe(200);
    const hostBody = await hostQuestions.json();
    const guestBody = await guestQuestions.json();
    expect(hostBody.questions).toEqual(guestBody.questions);
    expect(hostBody.questions).toHaveLength(3);
    expect(JSON.stringify(hostBody)).not.toMatch(/answerKey|hiddenExplanation|attemptId|groupId|sessionTokenHash/);

    const unauthorized = await handlers.questions(request("GET", "/api/play-groups/questions"));
    expect(unauthorized.status).toBe(401);
    const wrongCookie = await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: "moonlight_attempt=unrelated-session" }));
    expect(wrongCookie.status).toBe(401);
    const personalCookieAtGroupEndpoint = await handlers.current(request("GET", "/api/play-groups/current", { cookie: "moonlight_attempt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect(personalCookieAtGroupEndpoint.status).toBe(401);
    expect((await handlers.result(request("GET", "/api/play-groups/result", { cookie: hostCookie }))).status).toBe(409);

    expect((await answer(hostCookie, "q1", 0)).status).toBe(201);
    expect((await answer(hostCookie, "q2", 1)).status).toBe(201);
    expect((await answer(hostCookie, "q3", 2)).status).toBe(200);
    expect((await answer(hostCookie, "q1", 0)).status).toBe(200);
    expect((await answer(hostCookie, "q1", 1)).status).toBe(409);
    const waitingResult = await handlers.result(request("GET", "/api/play-groups/result", { cookie: hostCookie }));
    expect(waitingResult.status).toBe(409);
    const whileWaiting = await handlers.current(request("GET", "/api/play-groups/current", { cookie: hostCookie }));
    const waitingBody = await whileWaiting.json();
    expect(waitingBody).toMatchObject({ status: "ready", ownAnsweredCount: 3, otherJoined: true, otherCompleted: false });
    expect(JSON.stringify(waitingBody)).not.toMatch(/optionIndex|cueKey|answer|attemptId|groupId/);

    expect((await answer(guestCookie, "q1", 0)).status).toBe(201);
    expect((await answer(guestCookie, "q2", 2)).status).toBe(201);
    expect((await answer(guestCookie, "q3", 1)).status).toBe(200);
    const hostResult = await handlers.result(request("GET", "/api/play-groups/result", { cookie: hostCookie }));
    const guestResult = await handlers.result(request("GET", "/api/play-groups/result", { cookie: guestCookie }));
    expect(hostResult.status).toBe(200);
    expect(guestResult.status).toBe(200);
    const hostResultBody = await hostResult.json() as { result: { matchedCount: number; total: number; message: string; questions: { cueKey: string; matched: boolean; yourOptionIndex: number; friendOptionIndex: number }[] } };
    const guestResultBody = await guestResult.json() as typeof hostResultBody;
    expect(hostResultBody.result).toMatchObject({ matchedCount: 1, total: 3, questions: [{ cueKey: "q1", matched: true }, { cueKey: "q2", matched: false }, { cueKey: "q3", matched: false }] });
    expect(guestResultBody.result).toMatchObject({ matchedCount: 1, total: 3, message: hostResultBody.result.message, questions: hostResultBody.result.questions.map(({ cueKey, matched }) => ({ cueKey, matched })) });
    expect(hostResultBody.result.questions[1]).toMatchObject({ yourOptionIndex: 1, friendOptionIndex: 2 });
    expect(guestResultBody.result.questions[1]).toMatchObject({ yourOptionIndex: 2, friendOptionIndex: 1 });
    expect(JSON.stringify(hostResultBody)).not.toMatch(/groupId|attemptId|sessionTokenHash|participantToken/);
    expect(await db.select().from(schema.submissions)).toHaveLength(6);
  });

  it("rejects a third member, consumed link with another session, malformed/cross-origin writes, and invalid cookies", async () => {
    const entry = await fixture();
    const created = await createRoom(entry.tableCode);
    const { invitationToken } = await created.json();
    const joined = await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true } }));
    expect(joined.status).toBe(201);
    const third = await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true } }));
    expect(third.status).toBe(409);
    expect(await third.json()).toEqual({ error: "group_full" });
    const consumed = await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true }, cookie: "moonlight_group_attempt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect([401, 409]).toContain(consumed.status);
    const csrf = await handlers.leave(request("POST", "/api/play-groups/leave", { cookie: cookieFrom(created), origin: "https://attacker.example" }));
    expect(csrf.status).toBe(403);
    const malformed = await handlers.answer(request("POST", "/api/play-groups/answer", { cookie: cookieFrom(created), body: { cueKey: "q1", optionIndex: 0, participantToken: "leak" } }));
    expect(malformed.status).toBe(400);
    const forged = await handlers.current(request("GET", "/api/play-groups/current", { cookie: "moonlight_group_attempt=forged" }));
    expect(forged.status).toBe(401);
    expect(forged.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(await db.select().from(schema.attempts)).toHaveLength(2);
  });

  it("blocks group reads and writes when the venue is suspended while leaving publication deactivation semantics alone", async () => {
    const entry = await fixture();
    const created = await createRoom(entry.tableCode);
    const hostCookie = cookieFrom(created);
    const { invitationToken } = await created.json();
    await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true } }));
    await db.update(schema.publications).set({ status: "inactive", deactivatedAt: new Date() }).where(eq(schema.publications.id, entry.publication.id));
    expect((await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: hostCookie }))).status).toBe(200);
    await db.update(schema.venues).set({ status: "suspended" }).where(eq(schema.venues.id, entry.venue.id));
    expect((await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: hostCookie }))).status).toBe(409);
    expect((await handlers.current(request("GET", "/api/play-groups/current", { cookie: hostCookie }))).status).toBe(409);
    expect((await answer(hostCookie, "q1", 0)).status).toBe(409);
    expect((await handlers.result(request("GET", "/api/play-groups/result", { cookie: hostCookie }))).status).toBe(409);
  });

  it("blocks invitation preview, joining, reads, and answers after the bound table is paused", async () => {
    const entry = await fixture();
    const created = await createRoom(entry.tableCode);
    const hostCookie = cookieFrom(created);
    const { invitationToken } = await created.json();
    await db.update(schema.venueTables).set({ isEnabled: false }).where(eq(schema.venueTables.id, entry.table.id));
    expect((await handlers.preview(request("POST", "/api/play-groups/invitation", { body: { invitationToken } }))).status).toBe(409);
    expect((await handlers.join(request("POST", "/api/play-groups/join", { body: { invitationToken, consent: true } }))).status).toBe(409);
    expect((await handlers.current(request("GET", "/api/play-groups/current", { cookie: hostCookie }))).status).toBe(409);
    expect((await handlers.questions(request("GET", "/api/play-groups/questions", { cookie: hostCookie }))).status).toBe(409);
    expect((await answer(hostCookie, "q1", 0)).status).toBe(409);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
  });

  it("creates no room when the adapter is unavailable and safely fails API reads", async () => {
    const unavailable = createPlayGroupApiHandlers({ databaseProvider: () => { throw new Error("private connection detail"); } });
    const response = await unavailable.current(request("GET", "/api/play-groups/current", { cookie: "moonlight_group_attempt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"service_unavailable"}');
  });

  it("keeps expired GET reads side-effect free and limits leave to the authenticated member", async () => {
    const entry = await fixture();
    const created = await createRoom(entry.tableCode);
    const cookie = cookieFrom(created);
    const [{ id: groupId }] = await db.select({ id: schema.playGroups.id }).from(schema.playGroups);
    const expiredAt = Date.now() - 60_000;
    await db.update(schema.playGroups).set({ createdAt: new Date(expiredAt - 60_000), expiresAt: new Date(expiredAt) }).where(eq(schema.playGroups.id, groupId));
    const beforeGroup = await db.select({ status: schema.playGroups.status }).from(schema.playGroups).where(eq(schema.playGroups.id, groupId));
    const beforeAttempt = await db.select({ status: schema.attempts.status }).from(schema.attempts);
    expect((await handlers.current(request("GET", "/api/play-groups/current", { cookie }))).status).toBe(409);
    expect((await handlers.result(request("GET", "/api/play-groups/result", { cookie }))).status).toBe(409);
    expect(await db.select({ status: schema.playGroups.status }).from(schema.playGroups).where(eq(schema.playGroups.id, groupId))).toEqual(beforeGroup);
    expect(await db.select({ status: schema.attempts.status }).from(schema.attempts)).toEqual(beforeAttempt);

    const notMine = await handlers.leave(request("POST", "/api/play-groups/leave", { cookie: "moonlight_group_attempt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect(notMine.status).toBe(401);
  });
});
