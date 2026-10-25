import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
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
] };

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
    const unavailable = createAttemptApiHandlers({ databaseProvider: () => { throw new Error("no database"); } });
    const response = await unavailable.start(new Request("http://localhost:3010/api/attempts/start", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3010", host: "127.0.0.1:3010", "content-type": "application/json" },
      body: JSON.stringify({ tableCode: randomBytes(32).toString("base64url") }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
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
});
