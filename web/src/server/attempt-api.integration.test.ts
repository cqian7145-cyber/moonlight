import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { hashToken } from "./tokens";
import { createAttemptApiHandlers } from "./attempt-api";

function createTestDatabase(client: PGlite) {
  return drizzle(client, { schema });
}

type TestDatabase = ReturnType<typeof createTestDatabase>;
type EntryOptions = { venueStatus?: "active" | "suspended"; tableEnabled?: boolean; publicationStatus?: "active" | "inactive" };
const baseUrl = "https://moonlight.test";
const content = { cues: [
  { key: "q1", prompt: "选择一", choices: ["甲", "乙", "丙"] },
  { key: "q2", prompt: "选择二", choices: ["甲", "乙", "丙"] },
  { key: "q3", prompt: "选择三", choices: ["甲", "乙", "丙"] },
], answerKey: [2, 2, 2], hiddenExplanation: "仅供后台使用" };

let client: PGlite;
let db: TestDatabase;
let handlers: ReturnType<typeof createAttemptApiHandlers>;

async function fixture(options: EntryOptions = {}, venueName = "月光小馆") {
  const tableCode = randomBytes(32).toString("base64url");
  const [venue] = await db.insert(schema.venues).values({ name: venueName, status: options.venueStatus ?? "active" }).returning();
  const [table] = await db.insert(schema.venueTables).values({
    venueId: venue.id, name: "靠窗 3 号桌", publicCodeHash: hashToken(tableCode), isEnabled: options.tableEnabled ?? true,
  }).returning();
  const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue.id, title: "今晚的微醺灵感" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId: venue.id, templateId: template.id, versionNo: 1, content }).returning();
  const [publication] = await db.insert(schema.publications).values({
    venueId: venue.id, versionId: version.id, status: options.publicationStatus ?? "active",
    activatedAt: new Date(Date.now() - 60_000),
    deactivatedAt: options.publicationStatus === "inactive" ? new Date() : null,
  }).returning();
  return { tableCode, venue, table, publication };
}

function post(body: unknown, options: { origin?: string | null; cookie?: string; url?: string; contentType?: string } = {}) {
  const url = options.url ?? `${baseUrl}/api/attempts/start`;
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  headers.set("host", new URL(url).host);
  if (options.origin !== null) headers.set("origin", options.origin ?? baseUrl);
  if (options.cookie) headers.set("cookie", options.cookie);
  return handlers.start(new Request(url, {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function getCurrent(tableCode: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handlers.current(new Request(`${baseUrl}/api/attempts/current?tableCode=${encodeURIComponent(tableCode)}`, { headers }));
}

function getQuestions(tableCode: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handlers.questions(new Request(`${baseUrl}/api/attempts/questions?tableCode=${encodeURIComponent(tableCode)}`, { headers }));
}

function postAnswer(body: unknown, cookie?: string, options: { origin?: string | null } = {}) {
  const url = `${baseUrl}/api/attempts/answer`;
  const headers = new Headers({ "content-type": "application/json", host: new URL(url).host });
  if (options.origin !== null) headers.set("origin", options.origin ?? baseUrl);
  if (cookie) headers.set("cookie", cookie);
  return handlers.answer(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

function getResult(tableCode: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handlers.result(new Request(`${baseUrl}/api/attempts/result?tableCode=${encodeURIComponent(tableCode)}`, { headers }));
}

function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0];
}

beforeEach(async () => {
  client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  handlers = createAttemptApiHandlers({ databaseProvider: () => db });
});

afterEach(async () => client.close());

describe("anonymous solo attempt HTTP handlers backed by the checked-in migration", () => {
  it("creates on explicit POST, persists one attempt, and returns only safe fields plus a hardened cookie", async () => {
    const entry = await fixture();
    const response = await post({ tableCode: entry.tableCode });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ status: "created", attempt: { status: "in_progress" }, activity: { title: "今晚的微醺灵感", questionCount: 3 } });
    expect(body).not.toHaveProperty("participantToken");
    expect(JSON.stringify(body)).not.toMatch(/sessionTokenHash|attemptId|publicationId|venueId|participantToken/);
    const cookie = cookieFrom(response);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(response.headers.get("set-cookie")).toMatch(/Path=\/api\/attempts/i);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=/i);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
    const attempts = await db.select().from(schema.attempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.mode).toBe("solo");
    expect(attempts[0]?.sessionTokenHash).not.toBe(cookie.split("=")[1]);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
  });

  it("retries POST idempotently and GET restores the same session without writing", async () => {
    const entry = await fixture();
    const first = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(first);
    const firstBody = await first.json();
    const repeated = await post({ tableCode: entry.tableCode }, { cookie });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "resumed", attempt: firstBody.attempt, activity: firstBody.activity });
    const current = await getCurrent(entry.tableCode, cookie);
    expect(current.status).toBe(200);
    const currentBody = await current.json();
    expect(currentBody).toMatchObject({
      status: "current", attempt: { status: "in_progress", startedAt: firstBody.attempt.startedAt, answeredCount: 0 },
      activity: { title: "今晚的微醺灵感", questionCount: 3 },
    });
    expect(JSON.stringify(currentBody)).not.toMatch(/participantToken|sessionTokenHash|optionIndex/);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
  });

  it("does not create on GET and requires a same-origin POST", async () => {
    const entry = await fixture();
    expect((await getCurrent(entry.tableCode)).status).toBe(401);
    expect(await db.select().from(schema.attempts)).toHaveLength(0);
    const crossSite = await post({ tableCode: entry.tableCode }, { origin: "https://attacker.example" });
    expect(crossSite.status).toBe(403);
    const noOrigin = await post({ tableCode: entry.tableCode }, { origin: null });
    expect(noOrigin.status).toBe(403);
    expect(await db.select().from(schema.attempts)).toHaveLength(0);
  });

  it("compares Origin with the incoming Host when Next's internal request URL uses another host", async () => {
    const unavailable = createAttemptApiHandlers({ databaseProvider: () => { throw new Error("no database"); }, trustedOrigin: "http://127.0.0.1:3010" });
    const response = await unavailable.start(new Request("http://localhost:3010/api/attempts/start", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3010", host: "127.0.0.1:3010", "content-type": "application/json" },
      body: JSON.stringify({ tableCode: randomBytes(32).toString("base64url") }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("does not accept a client supplied forwarded protocol as trusted CSRF context", async () => {
    const trusted = createAttemptApiHandlers({ databaseProvider: () => db, trustedOrigin: baseUrl });
    const entry = await fixture();
    const url = `http://moonlight.test/api/attempts/start`;
    const response = await trusted.start(new Request(url, {
      method: "POST",
      headers: { origin: baseUrl, host: "moonlight.test", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ tableCode: entry.tableCode }),
    }));
    expect(response.status).toBe(403);
    expect(await db.select().from(schema.attempts)).toHaveLength(0);
  });

  it("rejects invalid, paused, and inactive entries without creating attempts", async () => {
    const invalid = await post({ tableCode: "short" });
    expect(invalid.status).toBe(400);
    const pausedTable = await fixture({ tableEnabled: false });
    expect((await post({ tableCode: pausedTable.tableCode })).status).toBe(409);
    const pausedVenue = await fixture({ venueStatus: "suspended" });
    expect((await post({ tableCode: pausedVenue.tableCode })).status).toBe(409);
    const inactive = await fixture({ publicationStatus: "inactive" });
    expect((await post({ tableCode: inactive.tableCode })).status).toBe(409);
    expect(await db.select().from(schema.attempts)).toHaveLength(0);
  });

  it("rejects invalid cookies and cross-venue recovery without exposing the previous attempt", async () => {
    const firstVenue = await fixture();
    const secondVenue = await fixture({}, "另一家门店");
    const started = await post({ tableCode: firstVenue.tableCode });
    const cookie = cookieFrom(started);
    const secondStart = await post({ tableCode: secondVenue.tableCode }, { cookie });
    const secondStartBody = await secondStart.json();
    expect(secondStart.status).toBe(401);
    expect(secondStartBody).toEqual({ error: "session_unavailable" });
    expect((await getCurrent(secondVenue.tableCode, cookie)).status).toBe(401);
    const forged = await getCurrent(firstVenue.tableCode, "moonlight_attempt=forged-token");
    expect(forged.status).toBe(401);
    expect(forged.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
    const serialized = JSON.stringify(secondStartBody);
    expect(serialized).not.toContain(firstVenue.venue.id);
  });

  it("does not expose non-solo attempts through the personal session endpoint", async () => {
    const entry = await fixture();
    const token = randomBytes(32).toString("base64url");
    const [group] = await db.insert(schema.playGroups).values({
      venueId: entry.venue.id, publicationId: entry.publication.id, tableId: entry.table.id,
      inviteCodeHash: hashToken(randomBytes(32).toString("base64url")), expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    await db.insert(schema.attempts).values({
      publicationId: entry.publication.id, playGroupId: group.id, mode: "duo", consentedAt: new Date(),
      sessionTokenHash: hashToken(token),
    });
    const response = await getCurrent(entry.tableCode, `moonlight_attempt=${token}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_unavailable" });
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("rejects malformed bodies and fails closed with a sanitized 503 when the adapter is unavailable", async () => {
    const entry = await fixture();
    expect((await post("{", { contentType: "application/json" })).status).toBe(400);
    expect((await post(`{"tableCode":"${"x".repeat(2_000)}"}`, { contentType: "application/json" })).status).toBe(400);
    expect((await post({ tableCode: entry.tableCode, venueId: entry.venue.id })).status).toBe(400);
    expect((await post({ tableCode: entry.tableCode }, { contentType: "text/plain" })).status).toBe(415);
    const unavailable = createAttemptApiHandlers({ databaseProvider: () => { throw new Error("private connection detail"); } });
    const unavailableUrl = `${baseUrl}/api/attempts/start`;
    const response = await unavailable.start(new Request(unavailableUrl, {
      method: "POST", headers: { origin: baseUrl, host: new URL(unavailableUrl).host, "content-type": "application/json" }, body: JSON.stringify({ tableCode: entry.tableCode }),
    }));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('{"error":"service_unavailable"}');
    expect(body).not.toContain("private connection detail");
  });

  it("reads only the owned attempt's safe immutable questions and restores partial answers without writes", async () => {
    const entry = await fixture();
    expect((await getQuestions(entry.tableCode)).status).toBe(401);
    const started = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(started);

    const questionsResponse = await getQuestions(entry.tableCode, cookie);
    expect(questionsResponse.status).toBe(200);
    const questions = await questionsResponse.json();
    expect(questions).toMatchObject({
      attempt: { status: "in_progress", answeredCount: 0 },
      activity: { title: "今晚的微醺灵感" },
      submissions: [],
    });
    expect(questions.questions).toHaveLength(3);
    expect(questions.questions[0]).toEqual({ cueKey: "q1", prompt: "选择一", choices: ["甲", "乙", "丙"] });
    expect(JSON.stringify(questions)).not.toMatch(/answerKey|hiddenExplanation|sessionTokenHash|participantToken|attemptId|publicationId|venueId/);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);

    const answer = await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 2 }, cookie);
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ outcome: "created", attempt: { status: "in_progress", answeredCount: 1 } });
    const restored = await getQuestions(entry.tableCode, cookie);
    expect(await restored.json()).toMatchObject({
      attempt: { status: "in_progress", answeredCount: 1 },
      submissions: [{ cueKey: "q1", optionIndex: 2 }],
    });
    expect(await db.select().from(schema.submissions)).toHaveLength(1);
  });

  it("persists three distinct answers, protects retries, completes once, and restores the same deterministic solo result", async () => {
    const entry = await fixture();
    const started = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(started);

    const first = await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 0 }, cookie);
    expect(first.status).toBe(201);
    const repeated = await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 0 }, cookie);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ outcome: "duplicate", attempt: { status: "in_progress", answeredCount: 1 } });
    const conflict = await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 1 }, cookie);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "answer_conflict" });

    expect((await postAnswer({ tableCode: entry.tableCode, cueKey: "unknown", optionIndex: 0 }, cookie)).status).toBe(400);
    expect((await postAnswer({ tableCode: entry.tableCode, cueKey: "q2", optionIndex: 3 }, cookie)).status).toBe(400);
    expect((await postAnswer({ tableCode: entry.tableCode, cueKey: "q2", optionIndex: 0 }, cookie, { origin: "https://attacker.example" })).status).toBe(403);
    expect(await db.select().from(schema.submissions)).toHaveLength(1);

    const second = await postAnswer({ tableCode: entry.tableCode, cueKey: "q2", optionIndex: 0 }, cookie);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ attempt: { status: "in_progress", answeredCount: 2 } });
    expect((await getResult(entry.tableCode, cookie)).status).toBe(409);
    const third = await postAnswer({ tableCode: entry.tableCode, cueKey: "q3", optionIndex: 1 }, cookie);
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ attempt: { status: "completed", answeredCount: 3 } });
    expect(await db.select().from(schema.submissions)).toHaveLength(3);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);

    const resultResponse = await getResult(entry.tableCode, cookie);
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    expect(result).toMatchObject({ result: { id: "easygoing", title: expect.any(String) } });
    expect(JSON.stringify(result)).not.toMatch(/attemptId|participantToken|sessionTokenHash/);
    expect(await (await getResult(entry.tableCode, cookie)).json()).toEqual(result);
    expect(await (await getQuestions(entry.tableCode, cookie)).json()).toMatchObject({
      attempt: { status: "completed", answeredCount: 3 },
      submissions: expect.arrayContaining([
        expect.objectContaining({ cueKey: "q1", optionIndex: 0 }),
        expect.objectContaining({ cueKey: "q2", optionIndex: 0 }),
        expect.objectContaining({ cueKey: "q3", optionIndex: 1 }),
      ]),
    });

    const completedRetry = await postAnswer({ tableCode: entry.tableCode, cueKey: "q3", optionIndex: 1 }, cookie);
    expect(completedRetry.status).toBe(200);
    expect(await completedRetry.json()).toMatchObject({ outcome: "duplicate", attempt: { status: "completed", answeredCount: 3 } });
    const closed = await postAnswer({ tableCode: entry.tableCode, cueKey: "q3", optionIndex: 2 }, cookie);
    expect(closed.status).toBe(409);
    expect(await db.select().from(schema.submissions)).toHaveLength(3);
  });

  it("does not return questions or results for a different venue, abandoned attempt, or missing session", async () => {
    const firstVenue = await fixture();
    const secondVenue = await fixture({}, "另一家门店");
    const started = await post({ tableCode: firstVenue.tableCode });
    const cookie = cookieFrom(started);
    expect((await getQuestions(secondVenue.tableCode, cookie)).status).toBe(401);
    expect((await getResult(firstVenue.tableCode, cookie)).status).toBe(409);
    expect((await postAnswer({ tableCode: firstVenue.tableCode, cueKey: "q1", optionIndex: 0 })).status).toBe(401);
    await db.update(schema.attempts).set({ status: "abandoned" }).where(eq(schema.attempts.sessionTokenHash, hashToken(cookie.split("=")[1]!)));
    expect((await getQuestions(firstVenue.tableCode, cookie)).status).toBe(409);
    expect((await postAnswer({ tableCode: firstVenue.tableCode, cueKey: "q1", optionIndex: 0 }, cookie)).status).toBe(409);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
  });

  it("continues an existing attempt from its bound immutable package after the publication is deactivated", async () => {
    const entry = await fixture();
    const started = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(started);
    await db.update(schema.publications).set({ status: "inactive", deactivatedAt: new Date() })
      .where(eq(schema.publications.id, entry.publication.id));

    const questions = await getQuestions(entry.tableCode, cookie);
    expect(questions.status).toBe(200);
    expect(await questions.json()).toMatchObject({ activity: { title: "今晚的微醺灵感" }, questions: expect.any(Array) });
    const answer = await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 1 }, cookie);
    expect(answer.status).toBe(201);
    expect(await db.select().from(schema.submissions)).toHaveLength(1);
  });

  it("fails closed without exposing adapter details for the new answer and result endpoints", async () => {
    const unavailable = createAttemptApiHandlers({ databaseProvider: () => { throw new Error("private connection detail"); } });
    const cookie = `moonlight_attempt=${randomBytes(32).toString("base64url")}`;
    const code = randomBytes(32).toString("base64url");
    const questionResponse = await unavailable.questions(new Request(`${baseUrl}/api/attempts/questions?tableCode=${code}`, {
      headers: { cookie },
    }));
    expect(questionResponse.status).toBe(503);
    const answerUrl = `${baseUrl}/api/attempts/answer`;
    const answerResponse = await unavailable.answer(new Request(answerUrl, {
      method: "POST", headers: { cookie, origin: baseUrl, host: new URL(answerUrl).host, "content-type": "application/json" },
      body: JSON.stringify({ tableCode: code, cueKey: "q1", optionIndex: 0 }),
    }));
    expect(answerResponse.status).toBe(503);
    const resultResponse = await unavailable.result(new Request(`${baseUrl}/api/attempts/result?tableCode=${code}`, {
      headers: { cookie },
    }));
    expect(resultResponse.status).toBe(503);
    for (const response of [questionResponse, answerResponse, resultResponse]) {
      expect(await response.text()).toBe('{"error":"service_unavailable"}');
    }
  });

  it("keeps the owned solo session usable after code rotation while the old code cannot start a new attempt", async () => {
    const entry = await fixture();
    const started = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(started);
    const replacementCode = randomBytes(32).toString("base64url");
    await db.update(schema.venueTables).set({ publicCodeHash: hashToken(replacementCode) }).where(eq(schema.venueTables.id, entry.table.id));

    expect((await post({ tableCode: entry.tableCode })).status).toBe(404);
    expect((await getCurrent(entry.tableCode, cookie)).status).toBe(200);
    expect((await getQuestions(entry.tableCode, cookie)).status).toBe(200);
    for (const cueKey of ["q1", "q2", "q3"]) {
      const response = await postAnswer({ tableCode: entry.tableCode, cueKey, optionIndex: 1 }, cookie);
      expect([200, 201]).toContain(response.status);
    }
    expect((await getResult(entry.tableCode, cookie)).status).toBe(200);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
    expect(await db.select().from(schema.submissions)).toHaveLength(3);
  });

  it("blocks a suspended venue's in-progress reads and answer writes, then resumes without deleting history", async () => {
    const entry = await fixture();
    const started = await post({ tableCode: entry.tableCode });
    const cookie = cookieFrom(started);
    await db.update(schema.venues).set({ status: "suspended" }).where(eq(schema.venues.id, entry.venue.id));
    expect((await getCurrent(entry.tableCode, cookie)).status).toBe(409);
    expect((await getQuestions(entry.tableCode, cookie)).status).toBe(409);
    expect((await postAnswer({ tableCode: entry.tableCode, cueKey: "q1", optionIndex: 1 }, cookie)).status).toBe(409);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
    await db.update(schema.venues).set({ status: "active" }).where(eq(schema.venues.id, entry.venue.id));
    expect((await getQuestions(entry.tableCode, cookie)).status).toBe(200);
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
  });
});
