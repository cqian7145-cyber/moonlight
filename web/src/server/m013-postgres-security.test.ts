import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth";
import { createFeedbackApiHandlers } from "./feedback-api";
import { getSoloQuestions, getSoloResult, submitAnswer } from "./attempts";
import { hashToken } from "./tokens";
import { createMerchantOperationsHandlers } from "./merchant-operations";

const enabled = process.env.MOONLIGHT_REAL_PG === "1";
const origin = "http://localhost:3001";

describe("M-013 real PostgreSQL submission, feedback, and emergency-stop controls", () => {
  it.skipIf(!enabled)("serializes independent answer retries, rejects conflicting answers, and blocks reads after venue suspension", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for M-013 PostgreSQL security gates.");
    const url = new URL(connectionString);
    if (!(new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase())) || url.port !== "55432" || url.pathname !== "/moonlight_dev") {
      throw new Error("M-013 PostgreSQL tests only accept the isolated D-drive loopback moonlight_dev database.");
    }

    const pools = [0, 1, 2].map(() => new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000 }));
    const [setup, clientA, clientB] = pools.map((pool) => drizzleNode({ client: pool, schema }));
    const suffix = randomUUID().replaceAll("-", "");
    const cues = [1, 2, 3].map((number) => ({ key: `q${number}`, prompt: `虚构安全题 ${number}`, choices: ["甲", "乙", "丙"] }));
    try {
      await Promise.all(pools.map((pool) => pool.query("SET lock_timeout TO '5s'; SET statement_timeout TO '10s'")));
      const [venue] = await setup.insert(schema.venues).values({ name: `M-013 虚构安全验收 ${suffix.slice(0, 8)}` }).returning();
      const [template] = await setup.insert(schema.activityTemplates).values({ venueId: venue!.id, title: "M-013 虚构冻结题包" }).returning();
      const [version] = await setup.insert(schema.activityVersions).values({ venueId: venue!.id, templateId: template!.id, versionNo: 1, content: { title: "M-013 虚构冻结题包", cues } }).returning();
      const [publication] = await setup.insert(schema.publications).values({ venueId: venue!.id, versionId: version!.id }).returning();
      const duoRoom = await (await import("./play-groups")).createPlayGroup(setup as never, { venueId: venue!.id, consent: true });

      const sameToken = randomBytes(32).toString("base64url");
      const [sameAttempt] = await setup.insert(schema.attempts).values({ publicationId: publication!.id, mode: "solo", sessionTokenHash: hashToken(sameToken), startedAt: new Date() }).returning();
      const identical = await Promise.all([
        submitAnswer(clientA as never, { participantToken: sameToken, cueKey: cues[0]!.key, optionIndex: 1 }),
        submitAnswer(clientB as never, { participantToken: sameToken, cueKey: cues[0]!.key, optionIndex: 1 }),
      ]);
      expect(identical.map(({ outcome }) => outcome).sort()).toEqual(["created", "duplicate"]);
      let sameRows = await setup.select({ id: schema.submissions.id }).from(schema.submissions).where(and(
        eq(schema.submissions.attemptId, sameAttempt!.id), eq(schema.submissions.cueKey, cues[0]!.key),
      ));
      expect(sameRows).toHaveLength(1);

      const conflictToken = randomBytes(32).toString("base64url");
      const [conflictAttempt] = await setup.insert(schema.attempts).values({ publicationId: publication!.id, mode: "solo", sessionTokenHash: hashToken(conflictToken), startedAt: new Date() }).returning();
      const conflict = await Promise.allSettled([
        submitAnswer(clientA as never, { participantToken: conflictToken, cueKey: cues[0]!.key, optionIndex: 0 }),
        submitAnswer(clientB as never, { participantToken: conflictToken, cueKey: cues[0]!.key, optionIndex: 2 }),
      ]);
      expect(conflict.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(conflict.filter((item) => item.status === "rejected")).toHaveLength(1);
      const conflictRows = await setup.select({ id: schema.submissions.id }).from(schema.submissions).where(and(
        eq(schema.submissions.attemptId, conflictAttempt!.id), eq(schema.submissions.cueKey, cues[0]!.key),
      ));
      expect(conflictRows).toHaveLength(1);

      await setup.update(schema.venues).set({ status: "suspended" }).where(eq(schema.venues.id, venue!.id));
      await expect(getSoloQuestions(clientA as never, { participantToken: sameToken })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      await expect(getSoloResult(clientA as never, { participantToken: sameToken })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      await expect(submitAnswer(clientB as never, { participantToken: sameToken, cueKey: cues[1]!.key, optionIndex: 1 })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      await expect((await import("./attempts")).getDuoQuestions(clientA as never, { participantToken: duoRoom.participantToken })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      await expect(submitAnswer(clientB as never, { participantToken: duoRoom.participantToken, cueKey: cues[0]!.key, optionIndex: 1 })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      await expect((await import("./play-groups")).getPlayGroupState(clientA as never, { participantToken: duoRoom.participantToken })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
      sameRows = await setup.select({ id: schema.submissions.id }).from(schema.submissions).where(eq(schema.submissions.attemptId, sameAttempt!.id));
      expect(sameRows).toHaveLength(1);

      console.info("M-013 PG submission/security evidence", JSON.stringify({ separateConnections: 2, identicalRetryRows: 1, conflictingWrites: "one accepted, one rejected", emergencySuspension: "solo and duo read/write denied", priorRowsDeleted: 0 }));
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 30_000);

  it.skipIf(!enabled)("denies staff writes, cross-venue owner IDs, and revoked memberships with real PostgreSQL sessions", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for M-013 PostgreSQL security gates.");
    const url = new URL(connectionString);
    if (!(new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase())) || url.port !== "55432" || url.pathname !== "/moonlight_dev") {
      throw new Error("M-013 PostgreSQL tests only accept the isolated D-drive loopback moonlight_dev database.");
    }
    const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
    const db = drizzleNode({ client: pool, schema });
    const auth = createMerchantAuth(db as never, { baseURL: origin, secret: `m013-${randomBytes(48).toString("base64url")}`, allowProvisioning: true, secureCookies: false });
    const createdUsers: string[] = [];
    try {
      const [venueA] = await db.insert(schema.venues).values({ name: `M-013 授权虚构门店 A ${randomUUID().slice(0, 8)}` }).returning();
      const [venueB] = await db.insert(schema.venues).values({ name: `M-013 授权虚构门店 B ${randomUUID().slice(0, 8)}` }).returning();
      async function account(role: "owner" | "staff", venueId: string) {
        const email = `m013-${randomUUID()}@example.test`;
        const password = `One-time-${randomUUID()}-A9!`;
        const user = await auth.api.signUpEmail({ body: { name: `M-013 synthetic ${role}`, email, password } });
        createdUsers.push(user.user.id);
        const [member] = await db.insert(schema.venueMembers).values({ venueId, userId: user.user.id, role }).returning();
        const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST", headers: { origin, host: new URL(origin).host, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }));
        if (response.status !== 200) throw new Error("Synthetic PostgreSQL sign-in failed.");
        return { userId: user.user.id, memberId: member!.id, cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0]! };
      }
      const owner = await account("owner", venueA!.id);
      const staff = await account("staff", venueA!.id);
      const otherOwner = await account("owner", venueB!.id);
      const handlers = createMerchantOperationsHandlers(db as never, auth, { publicOrigin: origin });
      const draft = { title: "虚构权限测试草稿", cues: [1, 2, 3].map((number) => ({ prompt: `题目 ${number}`, choices: ["甲", "乙", "丙"] })) };
      const request = (venueId: string, cookie: string) => new Request(`${origin}/api/merchant/venues/${venueId}/activities`, {
        method: "POST", headers: { origin, host: new URL(origin).host, cookie, "content-type": "application/json" }, body: JSON.stringify(draft),
      });
      const staffWrite = await handlers.createDraft(request(venueA!.id, staff.cookie), venueA!.id);
      const crossVenueWrite = await handlers.createDraft(request(venueA!.id, otherOwner.cookie), venueA!.id);
      expect(staffWrite.status).toBe(403);
      expect(crossVenueWrite.status).toBe(403);
      await db.update(schema.venueMembers).set({ status: "disabled" }).where(eq(schema.venueMembers.id, owner.memberId));
      const revokedWrite = await handlers.createDraft(request(venueA!.id, owner.cookie), venueA!.id);
      expect(revokedWrite.status).toBe(403);
      const drafts = await db.select({ id: schema.activityTemplates.id }).from(schema.activityTemplates).where(eq(schema.activityTemplates.venueId, venueA!.id));
      expect(drafts).toHaveLength(0);
      console.info("M-013 PG authorization evidence", JSON.stringify({ staffWriteStatus: staffWrite.status, crossVenueStatus: crossVenueWrite.status, revokedMembershipStatus: revokedWrite.status, unauthorizedDrafts: drafts.length, syntheticAccountsToDisableInFinally: createdUsers.length }));
    } finally {
      if (createdUsers.length) {
        for (const userId of createdUsers) {
          await db.update(schema.authUsers).set({ disabled: true }).where(eq(schema.authUsers.id, userId));
          await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, userId));
          await db.update(schema.venueMembers).set({ status: "disabled" }).where(eq(schema.venueMembers.userId, userId));
        }
      }
      await pool.end();
    }
  }, 30_000);

  it.skipIf(!enabled)("allows only one durable rating when independent clients submit different values concurrently", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for M-013 PostgreSQL security gates.");
    const url = new URL(connectionString);
    if (!(new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase())) || url.port !== "55432" || url.pathname !== "/moonlight_dev") {
      throw new Error("M-013 PostgreSQL tests only accept the isolated D-drive loopback moonlight_dev database.");
    }

    const poolA = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
    const poolB = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
    const setupPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
    const dbs = [poolA, poolB, setupPool].map((pool) => drizzleNode({ client: pool, schema }));
    try {
      const [venue] = await dbs[2]!.insert(schema.venues).values({ name: `M-013 评分幂等验收 ${randomUUID().slice(0, 8)}` }).returning();
      const [template] = await dbs[2]!.insert(schema.activityTemplates).values({ venueId: venue!.id, title: "虚构题包" }).returning();
      const cues = [1, 2, 3].map((number) => ({ key: `rating-${number}`, prompt: `题目 ${number}`, choices: ["甲", "乙", "丙"] }));
      const [version] = await dbs[2]!.insert(schema.activityVersions).values({ venueId: venue!.id, templateId: template!.id, versionNo: 1, content: { cues } }).returning();
      const [publication] = await dbs[2]!.insert(schema.publications).values({ venueId: venue!.id, versionId: version!.id }).returning();
      const token = randomBytes(32).toString("base64url");
      const completedAt = new Date();
      const [attempt] = await dbs[2]!.insert(schema.attempts).values({ publicationId: publication!.id, mode: "solo", status: "completed", sessionTokenHash: hashToken(token), startedAt: new Date(completedAt.getTime() - 60_000), completedAt }).returning();
      const handlersA = createFeedbackApiHandlers({ databaseProvider: () => dbs[0] as never, trustedOrigin: origin });
      const handlersB = createFeedbackApiHandlers({ databaseProvider: () => dbs[1] as never, trustedOrigin: origin });
      const request = (rating: number) => new Request(`${origin}/api/attempts/feedback`, {
        method: "POST", headers: { host: "localhost:3001", origin, "content-type": "application/json", cookie: `moonlight_attempt=${token}` }, body: JSON.stringify({ rating }),
      });
      const responses = await Promise.all([handlersA.soloPost(request(4)), handlersB.soloPost(request(2))]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const rows = await dbs[2]!.select({ rating: schema.feedback.rating }).from(schema.feedback).where(eq(schema.feedback.attemptId, attempt!.id));
      expect(rows).toHaveLength(1);
      const migrationCount = (await setupPool.query<{ count: string }>("SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations")).rows[0];
      console.info("M-013 PG feedback/migration evidence", JSON.stringify({ independentConnections: 2, concurrentRatings: 2, persistedFeedbackRows: rows.length, statusCodes: responses.map((response) => response.status), checkedInMigrations: migrationCount?.count ?? "table unavailable", historicalRowsDeleted: 0 }));
    } finally {
      await Promise.all([poolA.end(), poolB.end(), setupPool.end()]);
    }
  }, 30_000);
});
