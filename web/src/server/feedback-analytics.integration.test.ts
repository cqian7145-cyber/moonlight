import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { getVenueAnalytics } from "./venue-analytics";
import { createFeedbackApiHandlers } from "./feedback-api";
import { hashToken } from "./tokens";

const origin = "https://moonlight.test";
const content = { cues: [{ key: "q1", prompt: "题一", choices: ["甲", "乙"] }] };
let client: PGlite;
let db: ReturnType<typeof drizzle>;

async function publicationFor(venueId: string, versionNo: number, status: "active" | "inactive" = "active") {
  const [template] = await db.insert(schema.activityTemplates).values({ venueId, title: "版本测试题包" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId, templateId: template!.id, versionNo, content }).returning();
  const [publication] = await db.insert(schema.publications).values({ venueId, versionId: version!.id, status, activatedAt: new Date(Date.now() - 90 * 86400_000), deactivatedAt: status === "inactive" ? new Date(Date.now() - 30 * 86400_000) : null }).returning();
  return publication!;
}

function request(path: string, method: "GET" | "POST", cookie: string, body?: unknown) {
  const url = `${origin}${path}`;
  return new Request(url, { method, headers: { host: new URL(url).host, ...(method === "POST" ? { origin, "content-type": "application/json" } : {}), cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("M-012 feedback and venue analytics on checked-in migrations", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  });
  afterEach(async () => client.close());

  it("stores one private rating per completed solo attempt, is idempotent, and rejects changed or invalid ratings", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "反馈测试门店" }).returning();
    const publication = await publicationFor(venue!.id, 1);
    const token = randomBytes(32).toString("base64url");
    const finished = new Date();
    const [attempt] = await db.insert(schema.attempts).values({ publicationId: publication.id, status: "completed", startedAt: new Date(finished.getTime() - 60_000), completedAt: finished, sessionTokenHash: hashToken(token) }).returning();
    const pendingToken = randomBytes(32).toString("base64url");
    await db.insert(schema.attempts).values({ publicationId: publication.id, sessionTokenHash: hashToken(pendingToken) });
    const handlers = createFeedbackApiHandlers({ databaseProvider: () => db as never });
    const cookie = `moonlight_attempt=${token}`;
    const post = (rating: unknown, session = cookie) => handlers.soloPost(request("/api/attempts/feedback", "POST", session, { rating }));
    const crossOrigin = await handlers.soloPost(new Request(`${origin}/api/attempts/feedback`, { method: "POST", headers: { host: "moonlight.test", origin: "https://attacker.example", cookie, "content-type": "application/json" }, body: JSON.stringify({ rating: 4 }) }));
    expect(crossOrigin.status).toBe(403);
    expect((await post(5)).status).toBe(201);
    expect((await post(5)).status).toBe(200);
    expect((await post(4)).status).toBe(409);
    expect((await post(0)).status).toBe(400);
    expect((await post(5, `moonlight_attempt=${pendingToken}`)).status).toBe(409);
    expect((await handlers.soloGet(request("/api/attempts/feedback", "GET", cookie))).status).toBe(200);
    expect((await handlers.soloGet(request("/api/attempts/feedback", "GET", ""))).status).toBe(401);
    const rows = await db.select().from(schema.feedback).where(eq(schema.feedback.attemptId, attempt!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rating).toBe(5);
    expect(await db.select().from(schema.feedback)).toHaveLength(1);
    expect((await post(3, "moonlight_attempt=forged-token")).status).toBe(401);
  });

  it("serializes concurrent identical ratings and returns 429 instead of accepting abusive retries", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "并发评分门店" }).returning();
    const publication = await publicationFor(venue!.id, 1);
    const token = randomBytes(32).toString("base64url");
    const at = new Date();
    const [attempt] = await db.insert(schema.attempts).values({ publicationId: publication.id, status: "completed", startedAt: new Date(at.getTime() - 1000), completedAt: at, sessionTokenHash: hashToken(token) }).returning();
    const handlers = createFeedbackApiHandlers({ databaseProvider: () => db as never, trustedOrigin: origin });
    const submit = () => handlers.soloPost(request("/api/attempts/feedback", "POST", `moonlight_attempt=${token}`, { rating: 4 }));
    const concurrent = await Promise.all([submit(), submit()]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    for (let count = 0; count < 8; count += 1) expect((await submit()).status).toBe(200);
    const blocked = await submit();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await db.select().from(schema.feedback).where(eq(schema.feedback.attemptId, attempt!.id))).toHaveLength(1);
  });

  it("keeps duo ratings private to each participant cookie instead of a shared room", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "双人反馈门店" }).returning();
    const publication = await publicationFor(venue!.id, 1);
    const [group] = await db.insert(schema.playGroups).values({ venueId: venue!.id, publicationId: publication.id, inviteCodeHash: hashToken(randomBytes(32).toString("base64url")), expiresAt: new Date(Date.now() + 60_000) }).returning();
    const tokenA = randomBytes(32).toString("base64url");
    const tokenB = randomBytes(32).toString("base64url");
    const created = new Date();
    const [attemptA] = await db.insert(schema.attempts).values({ publicationId: publication.id, playGroupId: group!.id, mode: "duo", status: "completed", consentedAt: created, startedAt: new Date(created.getTime() - 30_000), completedAt: created, sessionTokenHash: hashToken(tokenA) }).returning();
    const [attemptB] = await db.insert(schema.attempts).values({ publicationId: publication.id, playGroupId: group!.id, mode: "duo", status: "completed", consentedAt: created, startedAt: new Date(created.getTime() - 30_000), completedAt: created, sessionTokenHash: hashToken(tokenB) }).returning();
    const handlers = createFeedbackApiHandlers({ databaseProvider: () => db as never });
    const post = (token: string, rating: number) => handlers.duoPost(request("/api/play-groups/feedback", "POST", `moonlight_group_attempt=${token}`, { rating }));
    expect((await post(tokenA, 2)).status).toBe(201);
    expect((await handlers.duoGet(request("/api/play-groups/feedback", "GET", `moonlight_group_attempt=${tokenB}`))).status).toBe(200);
    expect(await (await handlers.duoGet(request("/api/play-groups/feedback", "GET", `moonlight_group_attempt=${tokenB}`))).json()).toEqual({ rating: null });
    expect((await post(tokenB, 5)).status).toBe(201);
    const [savedA] = await db.select().from(schema.feedback).where(eq(schema.feedback.attemptId, attemptA!.id));
    const [savedB] = await db.select().from(schema.feedback).where(eq(schema.feedback.attemptId, attemptB!.id));
    expect(savedA?.rating).toBe(2);
    expect(savedB?.rating).toBe(5);
    expect((await db.select().from(schema.feedback))).toHaveLength(2);
  });

  it("counts duo attempts twice but each room once, scopes every metric to a venue, and retains historical versions", async () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const [venue] = await db.insert(schema.venues).values({ name: "报表门店甲", timezone: "Asia/Shanghai" }).returning();
    const [other] = await db.insert(schema.venues).values({ name: "报表门店乙" }).returning();
    const [emptyVenue] = await db.insert(schema.venues).values({ name: "空数据门店" }).returning();
    const old = await publicationFor(venue!.id, 1, "inactive");
    const current = await publicationFor(venue!.id, 2);
    const outsiderPub = await publicationFor(other!.id, 1);
    const date = new Date("2026-10-23T10:00:00.000Z");
    const [group] = await db.insert(schema.playGroups).values({ venueId: venue!.id, publicationId: old.id, inviteCodeHash: hashToken("invitation-one"), expiresAt: new Date(date.getTime() + 3600_000), createdAt: date }).returning();
    for (const status of ["completed", "completed"] as const) {
      await db.insert(schema.attempts).values({ publicationId: old.id, playGroupId: group!.id, mode: "duo", status, consentedAt: date, startedAt: date, completedAt: date, sessionTokenHash: hashToken(randomBytes(32).toString("base64url")) });
    }
    await db.insert(schema.attempts).values({ publicationId: current.id, status: "completed", completedAt: date, startedAt: date, sessionTokenHash: hashToken("solo-current") });
    await db.insert(schema.attempts).values({ publicationId: outsiderPub.id, status: "completed", completedAt: date, startedAt: date, sessionTokenHash: hashToken("other-store") });
    await db.insert(schema.feedback).values({ attemptId: (await db.select({ id: schema.attempts.id }).from(schema.attempts).where(eq(schema.attempts.publicationId, current.id)))[0]!.id, rating: 4, createdAt: date });
    const startBoundary = new Date("2026-10-19T16:00:00.000Z");
    const endBoundary = now;
    await db.insert(schema.attempts).values({ publicationId: current.id, status: "completed", startedAt: startBoundary, completedAt: startBoundary, sessionTokenHash: hashToken("at-start-boundary") });
    await db.insert(schema.attempts).values({ publicationId: current.id, status: "completed", startedAt: endBoundary, completedAt: endBoundary, sessionTokenHash: hashToken("at-end-boundary") });

    const stats = await getVenueAnalytics(db as never, venue!.id, { days: 7, asOf: now });
    expect(stats).toMatchObject({ period: { days: 7, timezone: "Asia/Shanghai" }, summary: { attemptStarted: 4, attemptCompleted: 4, soloStarted: 2, duoStarted: 2, duoGroupsStarted: 1, duoGroupsFullyCompleted: 1, feedbackCount: 1, averageRating: 4 } });
    expect(stats.versions).toHaveLength(2);
    expect(stats.versions.map((item: { versionNo: number }) => item.versionNo).sort()).toEqual([1, 2]);
    const empty = await getVenueAnalytics(db as never, emptyVenue!.id, { days: 7, asOf: now });
    expect(empty.summary.attemptStarted).toBe(0);
    expect(empty.summary.completionRate).toBeNull();
    expect(empty.summary.averageRating).toBeNull();
    const [dstVenue] = await db.insert(schema.venues).values({ name: "DST 时区门店", timezone: "America/Los_Angeles" }).returning();
    const acrossSpringForward = await getVenueAnalytics(db as never, dstVenue!.id, { days: 7, asOf: new Date("2026-03-10T20:00:00.000Z") });
    expect(new Date(acrossSpringForward.period.start).toISOString()).toBe("2026-03-04T08:00:00.000Z");
  });
});
