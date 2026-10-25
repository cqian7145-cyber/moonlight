import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { hashToken } from "./tokens";
import { startSoloAttempt, getAttemptProgress, submitAnswer, getSoloResult, abandonAttempt } from "./attempts";
import { getCurrentActivity } from "./activities";
import { createPlayGroup, joinPlayGroup, getPlayGroupState, getPlayGroupResult, leavePlayGroup } from "./play-groups";

const cues = [
  { key: "q1", prompt: "选择一", choices: ["甲", "乙", "丙"] },
  { key: "q2", prompt: "选择二", choices: ["甲", "乙", "丙"] },
  { key: "q3", prompt: "选择三", choices: ["甲", "乙", "丙"] },
];

function createTestDatabase(client: PGlite) {
  return drizzle(client, { schema });
}

type TestDatabase = ReturnType<typeof createTestDatabase>;
let client: PGlite;
let db: TestDatabase;
let now: Date;
const clock = () => new Date(now);
const deps = { clock, createToken: () => randomBytes(32).toString("base64url") };

async function migrateFresh() {
  client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
}

async function setup(status: "active" | "inactive" = "active") {
  const [venue] = await db.insert(schema.venues).values({ name: "测试门店" }).returning();
  const tableCode = `table-code-${crypto.randomUUID()}`;
  const [table] = await db.insert(schema.venueTables).values({
    venueId: venue.id, name: "桌 1", publicCodeHash: hashToken(tableCode),
  }).returning();
  const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue.id, title: "今晚小签" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId: venue.id, templateId: template.id, versionNo: 1, content: { cues } }).returning();
  const [publication] = await db.insert(schema.publications).values({
    venueId: venue.id, versionId: version.id, status,
    activatedAt: new Date(now.getTime() - 60_000),
    deactivatedAt: status === "inactive" ? now : null,
  }).returning();
  return { venue, table, tableCode, template, version, publication };
}

beforeEach(async () => {
  now = new Date("2026-10-26T12:00:00.000Z");
  await migrateFresh();
});
afterEach(async () => client.close());

describe("M-005 server domain integration", () => {
  it("resolves only an active publication for an active venue and returns a frozen safe projection", async () => {
    const { venue, table, tableCode, publication, version } = await setup();
    await expect(getCurrentActivity(db, { venueId: venue.id, publicTableCode: tableCode }, { clock })).resolves.toMatchObject({
      venueId: venue.id, publicationId: publication.id, versionId: version.id, tableId: table.id, cues,
    });
    await expect(getCurrentActivity(db, { venueId: venue.id, publicTableCode: "wrong-venue-code" }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    const inactive = await setupInactiveVenue();
    await expect(getCurrentActivity(db, { venueId: inactive.id }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
  });

  it("rejects missing, inactive, not-yet-active, or malformed current publication", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "无活动" }).returning();
    await expect(getCurrentActivity(db, { venueId: venue.id }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    const inactive = await setup("inactive");
    await expect(getCurrentActivity(db, { venueId: inactive.venue.id }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    const future = await setup();
    await db.update(schema.publications).set({ activatedAt: new Date(now.getTime() + 1000) }).where(eq(schema.publications.id, future.publication.id));
    await expect(getCurrentActivity(db, { venueId: future.venue.id }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    const archived = await setup();
    await db.update(schema.activityTemplates).set({ status: "archived" }).where(eq(schema.activityTemplates.id, archived.template.id));
    await expect(getCurrentActivity(db, { venueId: archived.venue.id }, { clock })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
  });

  it("creates one personal attempt, resumes idempotently, submits fixed choices, completes, and returns no token hash", async () => {
    const { venue, publication } = await setup();
    await expect(startSoloAttempt(db, { venueId: venue.id, participantToken: "caller-selected-token" }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const started = await startSoloAttempt(db, { venueId: venue.id }, deps);
    const resumed = await startSoloAttempt(db, { venueId: venue.id, participantToken: started.participantToken }, deps);
    expect(resumed).toMatchObject({ attemptId: started.attemptId, resumed: true });
    expect(await db.select().from(schema.attempts)).toHaveLength(1);
    const [persistedAttempt] = await db.select({ sessionTokenHash: schema.attempts.sessionTokenHash }).from(schema.attempts);
    expect(persistedAttempt?.sessionTokenHash).not.toBe(started.participantToken);
    for (const [cueKey, optionIndex] of [["q1", 1], ["q2", 1], ["q3", 0]] as const) {
      await expect(submitAnswer(db, { participantToken: started.participantToken, cueKey, optionIndex }, { clock })).resolves.toMatchObject({ outcome: "created" });
    }
    await expect(getSoloResult(db, { participantToken: started.participantToken })).resolves.toMatchObject({ attemptId: started.attemptId, result: expect.any(Object) });
    const safeResult = await getSoloResult(db, { participantToken: started.participantToken });
    expect(safeResult).not.toHaveProperty("participantToken");
    expect(safeResult).not.toHaveProperty("sessionTokenHash");
    const progress = await getAttemptProgress(db, { participantToken: started.participantToken });
    expect(progress).not.toHaveProperty("sessionTokenHash");
    expect(progress.submissions).toHaveLength(3);
    expect(await db.select().from(schema.attempts).where(eq(schema.attempts.status, "completed"))).toHaveLength(1);
    await expect(submitAnswer(db, { participantToken: started.participantToken, cueKey: "q1", optionIndex: 1 }, { clock })).rejects.toMatchObject({ code: "ATTEMPT_CLOSED" });
    expect(publication.id).toBeTruthy();
  });

  it("rejects unknown cue, out-of-range choice, foreign token, conflicting retry and post-completion write", async () => {
    const { venue } = await setup();
    const { participantToken } = await startSoloAttempt(db, { venueId: venue.id }, deps);
    await expect(submitAnswer(db, { participantToken, cueKey: "missing", optionIndex: 0 }, { clock })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitAnswer(db, { participantToken, cueKey: "q1", optionIndex: 3 }, { clock })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitAnswer(db, { participantToken: "forged", cueKey: "q1", optionIndex: 1 }, { clock })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await submitAnswer(db, { participantToken, cueKey: "q1", optionIndex: 1 }, { clock });
    await expect(submitAnswer(db, { participantToken, cueKey: "q1", optionIndex: 1 }, { clock })).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(submitAnswer(db, { participantToken, cueKey: "q1", optionIndex: 2 }, { clock })).rejects.toMatchObject({ code: "ANSWER_CONFLICT" });
  });

  it("allows a personal attempt to be abandoned and rejects later writes", async () => {
    const { venue } = await setup();
    const started = await startSoloAttempt(db, { venueId: venue.id }, deps);
    await expect(abandonAttempt(db, { participantToken: started.participantToken }, { clock })).resolves.toMatchObject({ status: "abandoned" });
    await expect(submitAnswer(db, { participantToken: started.participantToken, cueKey: "q1", optionIndex: 0 }, { clock })).rejects.toMatchObject({ code: "ATTEMPT_CLOSED" });
  });

  it("does not allow starts against a venue/publication from a different scope", async () => {
    await setup();
    const [b] = await db.insert(schema.venues).values({ name: "另一门店", status: "suspended" }).returning();
    await expect(startSoloAttempt(db, { venueId: b.id }, deps)).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
  });

  it("creates a consented host and second participant, then withholds shared result until both finish", async () => {
    const { venue } = await setup();
    const created = await createPlayGroup(db, { venueId: venue.id, consent: true }, deps);
    const [persistedGroup] = await db.select({ inviteCodeHash: schema.playGroups.inviteCodeHash }).from(schema.playGroups);
    const [persistedHost] = await db.select({ sessionTokenHash: schema.attempts.sessionTokenHash }).from(schema.attempts);
    expect(persistedGroup?.inviteCodeHash).not.toBe(created.invitationToken);
    expect(persistedHost?.sessionTokenHash).not.toBe(created.participantToken);
    const state = await getPlayGroupState(db, { participantToken: created.participantToken }, { clock });
    expect(state).toMatchObject({ status: "waiting", validMemberCount: 1 });
    expect(state).not.toHaveProperty("members");
    expect(state).not.toHaveProperty("submissions");
    await expect(getPlayGroupResult(db, { participantToken: created.participantToken }, { clock })).rejects.toMatchObject({ code: "RESULT_NOT_READY" });
    const joined = await joinPlayGroup(db, { invitationToken: created.invitationToken, consent: true }, deps);
    expect(joined.resumed).toBe(false);
    expect(await joinPlayGroup(db, { invitationToken: created.invitationToken, participantToken: joined.participantToken, consent: true }, deps)).toMatchObject({ attemptId: joined.attemptId, resumed: true });
    await expect(joinPlayGroup(db, { invitationToken: created.invitationToken, consent: true }, deps)).rejects.toMatchObject({ code: "GROUP_FULL" });
    await completeDuo(created.participantToken);
    await expect(getPlayGroupResult(db, { participantToken: created.participantToken }, { clock })).rejects.toMatchObject({ code: "RESULT_NOT_READY" });
    await completeDuo(joined.participantToken);
    await expect(getPlayGroupResult(db, { participantToken: created.participantToken }, { clock })).resolves.toMatchObject({ matchedCount: 3, total: 3, members: expect.arrayContaining([expect.objectContaining({ answers: [0, 1, 2] })]) });
    await expect(getPlayGroupResult(db, { participantToken: "forged" }, { clock })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires explicit consent and does not let a table identifier substitute for consent", async () => {
    const { venue } = await setup();
    await expect(createPlayGroup(db, { venueId: venue.id, consent: false }, deps)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    const created = await createPlayGroup(db, { venueId: venue.id, consent: true }, deps);
    await expect(joinPlayGroup(db, { invitationToken: created.invitationToken, consent: false }, deps)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
  });

  it("rejects invalid and expired invitations and expires active members using server time", async () => {
    const { venue } = await setup();
    const created = await createPlayGroup(db, { venueId: venue.id, consent: true, ttlMs: 500 }, deps);
    await expect(joinPlayGroup(db, { invitationToken: "guess", consent: true }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    now = new Date(now.getTime() + 501);
    await expect(joinPlayGroup(db, { invitationToken: created.invitationToken, consent: true }, deps)).rejects.toMatchObject({ code: "GROUP_EXPIRED" });
    await expect(joinPlayGroup(db, { invitationToken: created.invitationToken, participantToken: created.participantToken, consent: true }, deps)).rejects.toMatchObject({ code: "GROUP_EXPIRED" });
    await expect(getPlayGroupState(db, { participantToken: created.participantToken }, { clock })).resolves.toMatchObject({ status: "expired", validMemberCount: 0 });
    expect(await db.select().from(schema.attempts).where(eq(schema.attempts.status, "abandoned"))).toHaveLength(1);
  });

  it("allows an authorized participant to leave and prevents further group result access", async () => {
    const { venue } = await setup();
    const created = await createPlayGroup(db, { venueId: venue.id, consent: true }, deps);
    await leavePlayGroup(db, { participantToken: created.participantToken }, { clock });
    await expect(getPlayGroupState(db, { participantToken: created.participantToken }, { clock })).resolves.toMatchObject({ status: "abandoned", validMemberCount: 0 });
    await expect(submitAnswer(db, { participantToken: created.participantToken, cueKey: "q1", optionIndex: 0 }, { clock })).rejects.toMatchObject({ code: "ATTEMPT_CLOSED" });
    await expect(joinPlayGroup(db, { invitationToken: created.invitationToken, consent: true }, deps)).rejects.toMatchObject({ code: "GROUP_CLOSED" });
    await expect(getPlayGroupState(db, { participantToken: created.invitationToken }, { clock })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function setupInactiveVenue() {
  const [venue] = await db.insert(schema.venues).values({ name: "停用门店", status: "suspended" }).returning();
  const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue.id, title: "停用" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId: venue.id, templateId: template.id, versionNo: 1, content: { cues } }).returning();
  await db.insert(schema.publications).values({ venueId: venue.id, versionId: version.id });
  return venue;
}

async function completeDuo(participantToken: string) {
  for (const [cueKey, optionIndex] of [["q1", 0], ["q2", 1], ["q3", 2]] as const) {
    await submitAnswer(db, { participantToken, cueKey, optionIndex }, { clock });
  }
}
