import "server-only";
import { getDb } from "../db";
import { getAttemptProgress, getSoloQuestions, getSoloResult, startSoloAttempt, submitAnswer } from "./attempts";
import { getCustomerTableContext, isValidPublicTableCode } from "./customer-entry";
import { DomainDb } from "./db-scoped";
import { DomainError, fail } from "./errors";
import { consumeRequestLimit, pruneExpiredRequestLimits, requestLimitIdentity } from "./request-limiter";
import { isTrustedSameOrigin } from "./request-origin";

const COOKIE_NAME = "moonlight_attempt";
const COOKIE_PATH = "/api/attempts";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const BODY_LIMIT_BYTES = 1024;
const PARTICIPANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AttemptApiOptions = { databaseProvider?: () => DomainDb; trustedOrigin?: string };
type CookieValue = { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; token: string };
type AnswerInput = { tableCode: string; cueKey: string; optionIndex: number };

function secureRequest(request: Request): boolean {
  return process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
}

function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    Vary: "Cookie",
  });
}

function json(status: number, body: unknown, cookie?: { token?: string; secure: boolean }): Response {
  const headers = responseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (cookie) {
    const value = cookie.token ? `${COOKIE_NAME}=${cookie.token}` : `${COOKIE_NAME}=; Max-Age=0`;
    const maxAge = cookie.token ? `; Max-Age=${COOKIE_MAX_AGE}` : "";
    const secure = cookie.secure ? "; Secure" : "";
    headers.append("Set-Cookie", `${value}${maxAge}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure}`);
  }
  return Response.json(body, { status, headers });
}

function readCookie(request: Request): CookieValue {
  const header = request.headers.get("cookie");
  if (!header) return { kind: "absent" };
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "invalid" };
  const token = matches[0]!.slice(COOKIE_NAME.length + 1);
  return PARTICIPANT_TOKEN_PATTERN.test(token) ? { kind: "valid", token } : { kind: "invalid" };
}

async function readTableCode(request: Request): Promise<string | null> {
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
    return null;
  }
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > BODY_LIMIT_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > BODY_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.tableCode !== "string" || !isValidPublicTableCode(record.tableCode)) return null;
  return record.tableCode;
}

async function readAnswerInput(request: Request): Promise<AnswerInput | null> {
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return null;
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > BODY_LIMIT_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > BODY_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.tableCode !== "string" || !isValidPublicTableCode(record.tableCode) ||
    typeof record.cueKey !== "string" || record.cueKey.trim().length === 0 || record.cueKey.length > 100 ||
    typeof record.optionIndex !== "number" || !Number.isInteger(record.optionIndex) || record.optionIndex < 0 || record.optionIndex > 2
  ) return null;
  return { tableCode: record.tableCode, cueKey: record.cueKey, optionIndex: record.optionIndex };
}

function readTableCodeQuery(request: Request): string | null {
  const codes = new URL(request.url).searchParams.getAll("tableCode");
  return codes.length === 1 && isValidPublicTableCode(codes[0]!) ? codes[0]! : null;
}

function safeQuestions(data: Awaited<ReturnType<typeof getSoloQuestions>>) {
  return {
    attempt: { status: data.status, startedAt: data.startedAt, completedAt: data.completedAt, answeredCount: data.submissions.length },
    activity: data.activity,
    questions: data.questions,
    submissions: data.submissions.map(({ cueKey, optionIndex, createdAt }) => ({ cueKey, optionIndex, createdAt })),
  };
}

function answerError(error: unknown, secure: boolean): Response {
  if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
  if (isDomainError(error, "INVALID_ANSWER")) return json(400, { error: "invalid_answer" });
  if (isDomainError(error, "ANSWER_CONFLICT")) return json(409, { error: "answer_conflict" });
  if (isDomainError(error, "ATTEMPT_CLOSED")) return json(409, { error: "attempt_closed" });
  if (isDomainError(error, "ACTIVITY_UNAVAILABLE")) return json(409, { error: "activity_unavailable" });
  return json(503, { error: "service_unavailable" });
}

function mapTableStatus(status: string): Response | null {
  if (status === "not_found") return json(404, { error: "table_not_found" });
  if (status === "table_paused" || status === "venue_paused") return json(409, { error: "table_unavailable" });
  return null;
}

async function soloAttemptVenueScope(db: DomainDb, tableCode: string): Promise<string | undefined> {
  const context = await getCustomerTableContext(db, tableCode);
  if (context.status === "not_found") return undefined;
  if (context.status !== "ready") fail("ACTIVITY_UNAVAILABLE");
  return context.venueId;
}

function isDomainError(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

export function createAttemptApiHandlers(options: AttemptApiOptions = {}) {
  const databaseProvider = options.databaseProvider ?? getDb;

  async function rateLimit(request: Request, db: DomainDb, operation: string, identity: string, maximum: number) {
    const result = await consumeRequestLimit(db, { operation, identity: requestLimitIdentity(request, identity), maximum, windowMs: 60_000 });
    await pruneExpiredRequestLimits(db);
    if (result.allowed) return null;
    const response = json(429, { error: "rate_limited" });
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
    return response;
  }

  async function start(request: Request): Promise<Response> {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });

    const cookie = readCookie(request);
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });

    let tableCode: string | null;
    let createdToken: string | undefined;
    try {
      tableCode = await readTableCode(request);
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (tableCode === null) {
      const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      return json(contentType === "application/json" ? 400 : 415, { error: "invalid_request" });
    }

    let db: DomainDb;
    try {
      db = databaseProvider();
    } catch {
      return json(503, { error: "service_unavailable" });
    }

    try {
      const limited = await rateLimit(request, db, "solo-start", cookie.kind === "valid" ? cookie.token : tableCode, 120);
      if (limited) return limited;
      const context = await getCustomerTableContext(db, tableCode);
      const unavailable = mapTableStatus(context.status);
      if (unavailable) return unavailable;
      if (context.status !== "ready") return json(404, { error: "table_not_found" });

      const started = await startSoloAttempt(db, {
        venueId: context.venueId,
        publicTableCode: tableCode,
        ...(cookie.kind === "valid" ? { participantToken: cookie.token } : {}),
      });
      createdToken = started.participantToken;
      const progress = await getAttemptProgress(db, { participantToken: started.participantToken, venueId: context.venueId });
      return json(started.resumed ? 200 : 201, {
        status: started.resumed ? "resumed" : "created",
        attempt: {
          status: progress.status,
          startedAt: progress.startedAt,
          completedAt: progress.completedAt,
          answeredCount: progress.submissions.length,
        },
        activity: progress.activity,
      }, { token: started.participantToken, secure });
    } catch (error) {
      if (isDomainError(error, "ACTIVITY_UNAVAILABLE")) return json(409, { error: "activity_unavailable" });
      if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
      return json(503, { error: "service_unavailable" }, createdToken ? { token: createdToken, secure } : undefined);
    }
  }

  async function current(request: Request): Promise<Response> {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });

    const url = new URL(request.url);
    const codes = url.searchParams.getAll("tableCode");
    if (codes.length !== 1 || !isValidPublicTableCode(codes[0]!)) return json(400, { error: "invalid_request" });

    let db: DomainDb;
    try {
      db = databaseProvider();
    } catch {
      return json(503, { error: "service_unavailable" });
    }

    try {
      const limited = await rateLimit(request, db, "solo-current", cookie.token, 600);
      if (limited) return limited;
      const venueId = await soloAttemptVenueScope(db, codes[0]!);
      const progress = await getAttemptProgress(db, { participantToken: cookie.token, ...(venueId ? { venueId } : {}) });
      if (progress.mode !== "solo") return json(401, { error: "session_unavailable" }, { secure });
      return json(200, {
        status: "current",
        attempt: {
          status: progress.status,
          startedAt: progress.startedAt,
          completedAt: progress.completedAt,
          answeredCount: progress.submissions.length,
        },
        activity: progress.activity,
      });
    } catch (error) {
      if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
      if (isDomainError(error, "ACTIVITY_UNAVAILABLE")) return json(409, { error: "activity_unavailable" });
      return json(503, { error: "service_unavailable" });
    }
  }

  async function questions(request: Request): Promise<Response> {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    const tableCode = readTableCodeQuery(request);
    if (!tableCode) return json(400, { error: "invalid_request" });

    let db: DomainDb;
    try {
      db = databaseProvider();
    } catch {
      return json(503, { error: "service_unavailable" });
    }

    try {
      const limited = await rateLimit(request, db, "solo-questions", cookie.token, 600);
      if (limited) return limited;
      const venueId = await soloAttemptVenueScope(db, tableCode);
      const data = await getSoloQuestions(db, { participantToken: cookie.token, ...(venueId ? { venueId } : {}) });
      if (data.status === "abandoned") return json(409, { error: "attempt_closed" });
      return json(200, { status: data.status === "completed" ? "completed" : "in_progress", ...safeQuestions(data) });
    } catch (error) {
      if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
      if (isDomainError(error, "ACTIVITY_UNAVAILABLE")) return json(409, { error: "activity_unavailable" });
      return json(503, { error: "service_unavailable" });
    }
  }

  async function answer(request: Request): Promise<Response> {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let input: AnswerInput | null;
    try {
      input = await readAnswerInput(request);
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (!input) {
      const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      return json(contentType === "application/json" ? 400 : 415, { error: "invalid_request" });
    }

    let db: DomainDb;
    try {
      db = databaseProvider();
    } catch {
      return json(503, { error: "service_unavailable" });
    }

    try {
      const limited = await rateLimit(request, db, "solo-answer", cookie.token, 120);
      if (limited) return limited;
      const venueId = await soloAttemptVenueScope(db, input.tableCode);
      const owned = await getSoloQuestions(db, { participantToken: cookie.token, ...(venueId ? { venueId } : {}) });
      if (owned.status !== "in_progress") {
        const question = owned.questions.find((item) => item.cueKey === input.cueKey);
        if (!question || input.optionIndex >= question.choices.length) return json(400, { error: "invalid_answer" });
        const previous = owned.submissions.find((item) => item.cueKey === input.cueKey);
        if (owned.status === "completed" && previous?.optionIndex === input.optionIndex) {
          return json(200, { outcome: "duplicate", attempt: { status: owned.status, answeredCount: owned.submissions.length } });
        }
        if (previous && previous.optionIndex !== input.optionIndex) return json(409, { error: "answer_conflict" });
        return json(409, { error: "attempt_closed" });
      }
      const submitted = await submitAnswer(db, {
        participantToken: cookie.token, cueKey: input.cueKey, optionIndex: input.optionIndex,
      });
      const updated = await getSoloQuestions(db, { participantToken: cookie.token, ...(venueId ? { venueId } : {}) });
      return json(submitted.outcome === "duplicate" || updated.status === "completed" ? 200 : 201, {
        outcome: submitted.outcome,
        attempt: { status: updated.status, answeredCount: updated.submissions.length },
      });
    } catch (error) {
      if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
      return answerError(error, secure);
    }
  }

  async function result(request: Request): Promise<Response> {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    const tableCode = readTableCodeQuery(request);
    if (!tableCode) return json(400, { error: "invalid_request" });

    let db: DomainDb;
    try {
      db = databaseProvider();
    } catch {
      return json(503, { error: "service_unavailable" });
    }

    try {
      const limited = await rateLimit(request, db, "solo-result", cookie.token, 600);
      if (limited) return limited;
      const venueId = await soloAttemptVenueScope(db, tableCode);
      const progress = await getAttemptProgress(db, { participantToken: cookie.token, ...(venueId ? { venueId } : {}) });
      if (progress.mode !== "solo") return json(401, { error: "session_unavailable" }, { secure });
      const completed = await getSoloResult(db, { participantToken: cookie.token });
      return json(200, { status: "completed", result: completed.result });
    } catch (error) {
      if (isDomainError(error, "NOT_FOUND")) return json(401, { error: "session_unavailable" }, { secure });
      if (isDomainError(error, "RESULT_NOT_READY")) return json(409, { error: "result_not_ready" });
      if (isDomainError(error, "ACTIVITY_UNAVAILABLE")) return json(409, { error: "activity_unavailable" });
      return json(503, { error: "service_unavailable" });
    }
  }

  return { start, current, questions, answer, result };
}
