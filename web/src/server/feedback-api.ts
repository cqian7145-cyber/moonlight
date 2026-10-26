import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import type { DomainDb } from "./db-scoped";
import { hashToken } from "./tokens";

type Options = { databaseProvider?: () => DomainDb };
const SOLO_COOKIE = "moonlight_attempt";
const DUO_COOKIE = "moonlight_group_attempt";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function headers() {
  return new Headers({ "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
}

function json(status: number, body: unknown) { return Response.json(body, { status, headers: headers() }); }

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const url = new URL(request.url);
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
    const protocol = forwarded === "http" || forwarded === "https" ? `${forwarded}:` : url.protocol;
    if (new URL(origin).origin !== new URL(`${protocol}//${host}`).origin) return false;
  } catch { return false; }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}

async function ratingBody(request: Request): Promise<number | null> {
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = request.headers.get("content-length");
  if (length && Number(length) > 256) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.byteLength;
    if (size > 256) { await reader.cancel(); return null; }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const rating = (value as Record<string, unknown>).rating;
  return typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

export function createFeedbackApiHandlers({ databaseProvider = getDb as () => DomainDb }: Options = {}) {
  async function handle(request: Request, mode: "solo" | "duo", method: "GET" | "POST"): Promise<Response> {
    if (method === "POST" && !sameOrigin(request)) return json(403, { error: "same_origin_required" });
    const participantToken = cookie(request, mode === "solo" ? SOLO_COOKIE : DUO_COOKIE);
    if (!participantToken) return json(401, { error: "session_unavailable" });
    let rating: number | null = null;
    try { if (method === "POST") rating = await ratingBody(request); }
    catch { return json(400, { error: "invalid_request" }); }
    if (method === "POST" && rating === null) return json(400, { error: "invalid_request" });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const [attempt] = await db.select({ id: schema.attempts.id, status: schema.attempts.status, mode: schema.attempts.mode })
        .from(schema.attempts).where(eq(schema.attempts.sessionTokenHash, hashToken(participantToken))).limit(1);
      if (!attempt || attempt.mode !== mode) return json(401, { error: "session_unavailable" });
      if (attempt.status !== "completed") return json(409, { error: "attempt_not_completed" });
      const [existing] = await db.select({ rating: schema.feedback.rating }).from(schema.feedback).where(eq(schema.feedback.attemptId, attempt.id)).limit(1);
      if (method === "GET") return json(200, { rating: existing?.rating ?? null });
      if (existing) return existing.rating === rating ? json(200, { status: "already_recorded", rating }) : json(409, { error: "feedback_conflict" });
      const [created] = await db.insert(schema.feedback).values({ attemptId: attempt.id, rating: rating! }).onConflictDoNothing({ target: schema.feedback.attemptId }).returning({ rating: schema.feedback.rating });
      if (created) return json(201, { status: "recorded", rating: created.rating });
      const [raced] = await db.select({ rating: schema.feedback.rating }).from(schema.feedback).where(eq(schema.feedback.attemptId, attempt.id)).limit(1);
      return raced?.rating === rating ? json(200, { status: "already_recorded", rating }) : json(409, { error: "feedback_conflict" });
    } catch { return json(503, { error: "service_unavailable" }); }
  }
  return {
    soloGet: (request: Request) => handle(request, "solo", "GET"),
    soloPost: (request: Request) => handle(request, "solo", "POST"),
    duoGet: (request: Request) => handle(request, "duo", "GET"),
    duoPost: (request: Request) => handle(request, "duo", "POST"),
  };
}
