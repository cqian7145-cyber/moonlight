import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createPlayGroup, joinPlayGroup } from "./play-groups";

const enabled = process.env.MOONLIGHT_REAL_PG === "1";

describe("M-009 real PostgreSQL capacity race", () => {
  it.skipIf(!enabled)("serializes two independent invitees at the final seat without a ghost attempt", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for the explicit PostgreSQL concurrency gate.");
    const url = new URL(connectionString);
    if (!(["127.0.0.1", "localhost", "::1"].includes(url.hostname)) || url.port !== "55432" || url.pathname !== "/moonlight_dev") {
      throw new Error("The real PostgreSQL gate only accepts the isolated loopback D-drive moonlight_dev instance.");
    }

    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m009_delay_${suffix}`;
    const triggerName = `m009_gate_${suffix}`;
    const poolSetup = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000 });
    const poolB = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000 });
    const poolC = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000 });
    let functionInstalled = false;
    let triggerInstalled = false;
    try {
      const setupDb = drizzleNode({ client: poolSetup, schema });
      const [venue] = await setupDb.insert(schema.venues).values({ name: `M-009 虚构并发验收 ${suffix.slice(0, 8)}` }).returning();
      const [template] = await setupDb.insert(schema.activityTemplates).values({ venueId: venue.id, title: "双人并发验收题包" }).returning();
      const [version] = await setupDb.insert(schema.activityVersions).values({
        venueId: venue.id, templateId: template.id, versionNo: 1,
        content: { cues: [
          { key: "race-1", prompt: "虚构题一", choices: ["甲", "乙", "丙"] },
          { key: "race-2", prompt: "虚构题二", choices: ["甲", "乙", "丙"] },
          { key: "race-3", prompt: "虚构题三", choices: ["甲", "乙", "丙"] },
        ] },
      }).returning();
      const [publication] = await setupDb.insert(schema.publications).values({ venueId: venue.id, versionId: version.id }).returning();
      const room = await createPlayGroup(setupDb, { venueId: venue.id, consent: true });

      const pids = await Promise.all([poolB, poolC].map(async (pool) => Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)));
      expect(pids[0]).not.toBe(pids[1]);
      await Promise.all([poolB, poolC].map(async (pool) => {
        await pool.query("SET lock_timeout TO '5s'");
        await pool.query("SET statement_timeout TO '8s'");
      }));

      await poolSetup.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`);
      functionInstalled = true;
      await poolSetup.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public.attempts FOR EACH ROW WHEN (NEW.mode = 'duo') EXECUTE FUNCTION public."${functionName}"()`);
      triggerInstalled = true;

      const dbB = drizzleNode({ client: poolB, schema });
      const dbC = drizzleNode({ client: poolC, schema });
      const joining = [
        joinPlayGroup(dbB, { invitationToken: room.invitationToken, consent: true }),
        joinPlayGroup(dbC, { invitationToken: room.invitationToken, consent: true }),
      ];
      const observedWaits: { wait_event_type: string; wait_event: string | null }[] = [];
      const deadline = Date.now() + 1_200;
      while (Date.now() < deadline && observedWaits.length === 0) {
        const waits = await poolSetup.query<{ wait_event_type: string; wait_event: string | null }>(
          "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
        );
        observedWaits.push(...waits.rows);
        if (observedWaits.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const outcomes = await Promise.allSettled(joining);
      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const losers = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: "GROUP_FULL" });
      expect(observedWaits.length).toBeGreaterThan(0);

      const persisted = await setupDb.select({ id: schema.attempts.id, playGroupId: schema.attempts.playGroupId, status: schema.attempts.status })
        .from(schema.attempts).where(eq(schema.attempts.playGroupId, room.groupId));
      expect(persisted).toHaveLength(2);
      expect(persisted.filter((attempt) => attempt.status !== "abandoned")).toHaveLength(2);
      const [updatedGroup] = await setupDb.select({ status: schema.playGroups.status }).from(schema.playGroups).where(eq(schema.playGroups.id, room.groupId));
      expect(updatedGroup?.status).toBe("paired");
      const attemptsWithAnswers = await setupDb.select({ attemptId: schema.submissions.attemptId }).from(schema.submissions)
        .innerJoin(schema.attempts, eq(schema.attempts.id, schema.submissions.attemptId)).where(eq(schema.attempts.playGroupId, room.groupId));
      expect(attemptsWithAnswers).toHaveLength(0);
      const scopedGroups = await setupDb.select({ id: schema.playGroups.id }).from(schema.playGroups).where(eq(schema.playGroups.id, room.groupId));
      expect(scopedGroups).toHaveLength(1);

      // These counts are deltas for this newly generated room; older test rows remain untouched.
      expect({ groupCount: 1, attemptCount: persisted.length, successfulJoinCount: winners.length, lockWaitCount: observedWaits.length }).toEqual({
        groupCount: 1, attemptCount: 2, successfulJoinCount: 1, lockWaitCount: expect.any(Number),
      });
      console.info("M-009 PostgreSQL concurrency evidence", JSON.stringify({ independentConnections: pids[0] !== pids[1], concurrentJoiners: 2, successfulJoins: winners.length, rejectedJoiners: losers.length, lockWaitCount: observedWaits.length, lockTimeoutMs: 5000, statementTimeoutMs: 8000, finalGroupMembers: persisted.length, ghostAttempts: 0, timedOut: false, retryNeeded: false }));
      expect(publication.id).toBeTruthy();
    } finally {
      if (triggerInstalled) {
        await poolSetup.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public.attempts`);
      }
      if (functionInstalled) {
        await poolSetup.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      }
      await Promise.all([poolSetup.end(), poolB.end(), poolC.end()]);
    }
  }, 15_000);
});
