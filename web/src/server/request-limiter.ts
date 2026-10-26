import "server-only";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { DomainDb } from "./db-scoped";
import { hashToken } from "./tokens";

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };
let writes = 0;

export function requestLimitIdentity(request: Request, fallbackIdentity: string): string {
  const configuredHeader = process.env.MOONLIGHT_TRUSTED_CLIENT_IP_HEADER?.toLowerCase();
  if (configuredHeader === "x-real-ip" || configuredHeader === "cf-connecting-ip") {
    const candidate = request.headers.get(configuredHeader)?.trim();
    if (candidate && isIP(candidate)) return `ip:${candidate}`;
  }
  return `resource:${fallbackIdentity}`;
}

export async function consumeRequestLimit(db: DomainDb, input: {
  operation: string;
  identity: string;
  maximum: number;
  windowMs: number;
  nowMs?: number;
}): Promise<RateLimitResult> {
  if (!/^[a-z0-9-]{1,48}$/.test(input.operation) || input.maximum < 1 || input.windowMs < 1000) {
    throw new Error("Invalid rate limit configuration");
  }
  const now = input.nowMs ?? Date.now();
  const key = `moonlight:public:v1:${input.operation}:${hashToken(input.identity)}`;
  const resetBefore = now - input.windowMs;
  const result = await db.execute(sql`
    INSERT INTO auth_rate_limits AS current_bucket (id, key, count, last_request)
    VALUES (${randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN current_bucket.last_request <= ${resetBefore} THEN 1 ELSE LEAST(current_bucket.count + 1, ${input.maximum + 1}) END,
      last_request = CASE WHEN current_bucket.last_request <= ${resetBefore} THEN ${now} ELSE current_bucket.last_request END
    RETURNING count, last_request
  `) as unknown as { rows: Array<{ count: number; last_request: number }> };
  const row = result.rows[0];
  if (!row) throw new Error("Rate limit storage returned no bucket");
  if (Number(row.count) <= input.maximum) return { allowed: true, remaining: input.maximum - Number(row.count) };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((Number(row.last_request) + input.windowMs - now) / 1000)) };
}

export async function pruneExpiredRequestLimits(db: DomainDb, nowMs = Date.now()): Promise<void> {
  writes += 1;
  if (writes % 128 !== 0) return;
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key LIKE 'moonlight:public:v1:%' AND last_request < ${nowMs - 24 * 60 * 60 * 1000}`);
}
