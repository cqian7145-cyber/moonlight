import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth";
import { createMerchantOperationsHandlers } from "./merchant-operations";

const enabled = process.env.MOONLIGHT_REAL_PG === "1";
const origin = "http://localhost:3000";
const secret = `m011-ephemeral-test-secret-${randomUUID()}-never-persisted`;

describe("M-011 real PostgreSQL publication race", () => {
  it.skipIf(!enabled)("serializes two owner publications on separate PostgreSQL connections and keeps one active", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for the explicit M-011 PostgreSQL gate.");
    const url = new URL(connectionString);
    if (!(new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase())) || url.port !== "55432" || url.pathname !== "/moonlight_dev") {
      throw new Error("The M-011 PostgreSQL gate only accepts the isolated D-drive loopback moonlight_dev database.");
    }

    const poolA = new Pool({ connectionString, max: 4, application_name: "m011-handler-a", connectionTimeoutMillis: 5_000 });
    const poolB = new Pool({ connectionString, max: 2, application_name: "m011-handler-b", connectionTimeoutMillis: 5_000 });
    const monitor = new Pool({ connectionString, max: 1, application_name: "m011-monitor", connectionTimeoutMillis: 5_000 });
    const blocker = new Pool({ connectionString, max: 1, application_name: "m011-lock-blocker", connectionTimeoutMillis: 5_000 });
    const dbA = drizzleNode({ client: poolA, schema });
    const dbB = drizzleNode({ client: poolB, schema });
    let venueId: string | undefined;
    let blockerOpen = false;

    try {
      const [venue] = await dbA.insert(schema.venues).values({ name: `M-011 虚构 PG 并发 ${randomUUID().slice(0, 8)}` }).returning();
      venueId = venue!.id;
      const auth = createMerchantAuth(dbA as never, { baseURL: origin, secret, allowProvisioning: true });
      const email = `m011-${randomUUID()}@example.test`;
      const password = `One-time-${randomUUID()}-A9!`;
      const created = await auth.api.signUpEmail({ body: { name: "M-011 虚构 owner", email, password } });
      await dbA.insert(schema.venueMembers).values({ venueId, userId: created.user.id, role: "owner" });
      const signIn = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { origin, host: "localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }));
      if (signIn.status !== 200) throw new Error("Synthetic PostgreSQL owner login failed.");
      const cookie = (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
      const handlersA = createMerchantOperationsHandlers(dbA as never, auth, { publicOrigin: origin });
      const handlersB = createMerchantOperationsHandlers(dbB as never, auth, { publicOrigin: origin });
      const headers = { cookie };
      const draftBody = { title: "真实 PG 并发题包", cues: [1, 2, 3].map((n) => ({ prompt: `题目 ${n}`, choices: ["甲", "乙", "丙"] })) };
      const templates = await Promise.all([1, 2].map(async (n) => {
        const [template] = await dbA.insert(schema.activityTemplates).values({
          venueId: venueId!, title: `${draftBody.title} ${n}`,
          draftContent: { title: `${draftBody.title} ${n}`, cues: draftBody.cues.map((cue, index) => ({ key: `question-${index + 1}`, ...cue })) },
        }).returning();
        return template!.id;
      }));

      const blockerClient = await blocker.connect();
      await blockerClient.query("BEGIN");
      blockerOpen = true;
      await blockerClient.query("SELECT id FROM venues WHERE id = $1 FOR UPDATE", [venueId]);
      await Promise.all([poolA, poolB].map((pool) => pool.query("SET lock_timeout TO '8s'; SET statement_timeout TO '12s'")));

      const publishes = [handlersA, handlersB].map((handlers, index) => handlers.publish(new Request(
        `${origin}/api/merchant/venues/${venueId}/activities/${templates[index]}/publish`, {
          method: "POST", headers: { ...headers, origin, host: "localhost:3000", "content-type": "application/json" },
          body: JSON.stringify({ expectedCurrentPublicationId: null }),
        }), venueId!, templates[index]!));
      const waiting: { application_name: string; pid: number; wait_event: string | null }[] = [];
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && waiting.length < 1) {
        const rows = await monitor.query<{ application_name: string; pid: number; wait_event: string | null }>(
          "SELECT application_name, pid, wait_event FROM pg_stat_activity WHERE datname = current_database() AND application_name IN ('m011-handler-a','m011-handler-b') AND wait_event_type = 'Lock'",
        );
        waiting.push(...rows.rows);
        if (!waiting.length) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting.length).toBeGreaterThan(0);
      await blockerClient.query("COMMIT");
      blockerOpen = false;
      blockerClient.release();
      const responses = await Promise.all(publishes);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const active = await dbA.select({ id: schema.publications.id }).from(schema.publications).where(and(
        eq(schema.publications.venueId, venueId!), eq(schema.publications.status, "active"),
      ));
      expect(active).toHaveLength(1);
      console.info("M-011 PostgreSQL publication race evidence", JSON.stringify({ independentPools: 2, lockWaitCount: waiting.length, successfulPublications: 1, staleConflicts: 1, activePublicationCount: active.length }));
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([poolA.end(), poolB.end(), monitor.end(), blocker.end()]);
    }
  }, 20_000);
});
