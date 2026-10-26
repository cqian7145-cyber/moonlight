import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { consumeRequestLimit } from "./request-limiter";
import { isTrustedSameOrigin } from "./request-origin";

let client: PGlite;
  let db: ReturnType<typeof drizzle>;

describe("request security primitives", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  });
  afterEach(async () => client.close());

  it("validates Origin against configured public origin and ignores spoofed forwarded protocol", () => {
    const trustedOrigin = "https://moonlight.example";
    const allowed = new Request("https://moonlight.example/api/attempts/start", {
      headers: { origin: trustedOrigin, host: "moonlight.example", "sec-fetch-site": "same-origin" },
    });
    expect(isTrustedSameOrigin(allowed, trustedOrigin)).toBe(true);
    const protocolSpoof = new Request("http://moonlight.example/api/attempts/start", {
      headers: { origin: trustedOrigin, host: "moonlight.example", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" },
    });
    expect(isTrustedSameOrigin(protocolSpoof, trustedOrigin)).toBe(false);
    const hostSpoof = new Request("https://attacker.example/api/attempts/start", {
      headers: { origin: trustedOrigin, host: "attacker.example", "x-forwarded-host": "moonlight.example", "sec-fetch-site": "same-origin" },
    });
    expect(isTrustedSameOrigin(hostSpoof, trustedOrigin)).toBe(false);
    const crossSite = new Request("https://moonlight.example/api/attempts/start", {
      headers: { origin: "https://attacker.example", host: "moonlight.example", "sec-fetch-site": "cross-site" },
    });
    expect(isTrustedSameOrigin(crossSite, trustedOrigin)).toBe(false);
  });

  it("atomically limits per operation and opaque identity, then permits requests after the window", async () => {
    const first = await consumeRequestLimit(db as never, { operation: "solo-start", identity: "fixture-table-secret", maximum: 2, windowMs: 60_000, nowMs: 1_000_000 });
    const second = await consumeRequestLimit(db as never, { operation: "solo-start", identity: "fixture-table-secret", maximum: 2, windowMs: 60_000, nowMs: 1_001_000 });
    const limited = await consumeRequestLimit(db as never, { operation: "solo-start", identity: "fixture-table-secret", maximum: 2, windowMs: 60_000, nowMs: 1_002_000 });
    const independent = await consumeRequestLimit(db as never, { operation: "solo-answer", identity: "fixture-table-secret", maximum: 2, windowMs: 60_000, nowMs: 1_002_000 });
    const afterWindow = await consumeRequestLimit(db as never, { operation: "solo-start", identity: "fixture-table-secret", maximum: 2, windowMs: 60_000, nowMs: 1_061_000 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(limited).toMatchObject({ allowed: false, retryAfterSeconds: 58 });
    expect(independent.allowed).toBe(true);
    expect(afterWindow.allowed).toBe(true);
    const stored = await db.select({ key: schema.authRateLimits.key }).from(schema.authRateLimits);
    expect(stored).toHaveLength(2);
    expect(stored.every(({ key }) => !key.includes("fixture-table-secret"))).toBe(true);
  });
});
