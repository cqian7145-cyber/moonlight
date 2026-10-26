import "server-only";
import { getDb } from "../db";
import { getAttemptProgress, getDuoQuestions, submitAnswer } from "./attempts";
import { getCustomerTableContext, isValidPublicTableCode } from "./customer-entry";
import { DomainDb } from "./db-scoped";
import { DomainError } from "./errors";
import { consumeRequestLimit, pruneExpiredRequestLimits, requestLimitIdentity } from "./request-limiter";
import { isTrustedSameOrigin } from "./request-origin";
import {
  createPlayGroup, getPlayGroupInvitation, getPlayGroupResult, getPlayGroupScope,
  getPlayGroupState, joinPlayGroup, leavePlayGroup,
} from "./play-groups";

const COOKIE_NAME = "moonlight_group_attempt";
const COOKIE_PATH = "/api/play-groups";
const DEFAULT_COOKIE_MAX_AGE = 15 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 2048;

type Options = { databaseProvider?: () => DomainDb; trustedOrigin?: string };
type Cookie = { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; token: string };

function secureRequest(request: Request) {
  return process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
}

function headers() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    Vary: "Cookie",
  });
}

function json(status: number, body: unknown, cookie?: { token?: string; maxAge?: number; secure: boolean }) {
  const responseHeaders = headers();
  if (cookie) {
    if (cookie.token) {
      const maxAge = Math.max(1, Math.min(DEFAULT_COOKIE_MAX_AGE, cookie.maxAge ?? DEFAULT_COOKIE_MAX_AGE));
      responseHeaders.append("Set-Cookie", `${COOKIE_NAME}=${cookie.token}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${cookie.secure ? "; Secure" : ""}`);
    } else {
      responseHeaders.append("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${cookie.secure ? "; Secure" : ""}`);
    }
  }
  return Response.json(body, { status, headers: responseHeaders });
}

function readCookie(request: Request): Cookie {
  const header = request.headers.get("cookie");
  if (!header) return { kind: "absent" };
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!matches.length) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "invalid" };
  const token = matches[0]!.slice(COOKIE_NAME.length + 1);
  return TOKEN_PATTERN.test(token) ? { kind: "valid", token } : { kind: "invalid" };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function errorResponse(error: unknown, secure: boolean, { clearCookie = false } = {}) {
  const cookie = clearCookie ? { secure } : undefined;
  if (!(error instanceof DomainError)) return json(503, { error: "service_unavailable" }, cookie);
  switch (error.code) {
    case "NOT_FOUND": return json(401, { error: "session_unavailable" }, { secure });
    case "INVITE_UNAVAILABLE": return json(404, { error: "invitation_unavailable" }, cookie);
    case "CONSENT_REQUIRED": return json(400, { error: "consent_required" }, cookie);
    case "INVALID_REQUEST": return json(400, { error: "invalid_request" }, cookie);
    case "INVALID_ANSWER": return json(400, { error: "invalid_answer" }, cookie);
    case "ANSWER_CONFLICT": return json(409, { error: "answer_conflict" }, cookie);
    case "GROUP_FULL": return json(409, { error: "group_full" }, cookie);
    case "GROUP_EXPIRED": return json(410, { error: "invitation_expired" }, cookie);
    case "GROUP_CLOSED": return json(409, { error: "group_closed" }, cookie);
    case "ATTEMPT_CLOSED": return json(409, { error: "attempt_closed" }, cookie);
    case "RESULT_NOT_READY": return json(409, { error: "result_not_ready" }, cookie);
    case "ACTIVITY_UNAVAILABLE": return json(409, { error: "activity_unavailable" }, cookie);
  }
}

function validTableCode(value: unknown): value is string {
  return typeof value === "string" && isValidPublicTableCode(value);
}

function invitationInput(value: unknown) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function questionsProjection(data: Awaited<ReturnType<typeof getDuoQuestions>>) {
  return {
    attempt: { status: data.status, startedAt: data.startedAt, completedAt: data.completedAt, answeredCount: data.submissions.length },
    activity: data.activity,
    questions: data.questions,
    submissions: data.submissions.map(({ cueKey, optionIndex, createdAt }) => ({ cueKey, optionIndex, createdAt })),
  };
}

export function createPlayGroupApiHandlers(options: Options = {}) {
  const databaseProvider = options.databaseProvider ?? getDb;

  async function rateLimit(request: Request, db: DomainDb, operation: string, identity: string, maximum: number) {
    const result = await consumeRequestLimit(db, { operation, identity: requestLimitIdentity(request, identity), maximum, windowMs: 60_000 });
    await pruneExpiredRequestLimits(db);
    if (result.allowed) return null;
    const response = json(429, { error: "rate_limited" });
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
    return response;
  }

  async function create(request: Request) {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    const cookie = readCookie(request);
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let body: Record<string, unknown> | null;
    try { body = await readJson(request); } catch { return json(400, { error: "invalid_request" }); }
    if (!body || Object.keys(body).length !== 2 || !validTableCode(body.tableCode) || typeof body.consent !== "boolean") return json(400, { error: "invalid_request" });
    if (!body.consent) return json(400, { error: "consent_required" });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-create", cookie.kind === "valid" ? cookie.token : String(body.tableCode), 120);
      if (limited) return limited;
      const table = await getCustomerTableContext(db, body.tableCode);
      if (table.status === "not_found") return json(404, { error: "table_not_found" });
      if (table.status !== "ready") return json(409, { error: "table_unavailable" });
      if (cookie.kind === "valid") {
        try {
          const scope = await getPlayGroupScope(db, { participantToken: cookie.token });
          if (scope.venueId !== table.venueId || scope.tableId !== table.tableId) return json(409, { error: "group_session_in_use" });
          const progress = await getAttemptProgress(db, { participantToken: cookie.token, venueId: table.venueId });
          if (progress.mode !== "duo") return json(401, { error: "session_unavailable" }, { secure });
          const state = await getPlayGroupState(db, { participantToken: cookie.token });
          if (state.status === "expired" || state.status === "abandoned") return json(409, { error: "group_closed" }, { secure });
          return json(200, {
            status: "resumed", room: { status: state.status, expiresAt: state.expiresAt },
            activity: progress.activity,
          });
        } catch (error) {
          if (!(error instanceof DomainError && error.code === "NOT_FOUND")) return errorResponse(error, secure);
          return json(409, { error: "group_session_in_use" });
        }
      }
      const created = await createPlayGroup(db, { venueId: table.venueId, tableId: table.tableId, consent: true });
      return json(201, {
        status: "created", invitationToken: created.invitationToken,
        expiresAt: created.expiresAt,
      }, { token: created.participantToken, maxAge: Math.floor((created.expiresAt.getTime() - Date.now()) / 1000), secure });
    } catch (error) {
      return errorResponse(error, secure);
    }
  }

  async function preview(request: Request) {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    let body: Record<string, unknown> | null;
    try { body = await readJson(request); } catch { return json(400, { error: "invalid_request" }); }
    if (!body || Object.keys(body).length !== 1 || !invitationInput(body.invitationToken)) return json(400, { error: "invalid_request" });
    const invitationToken = body.invitationToken as string;
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-invite-preview", invitationToken, 300);
      if (limited) return limited;
      const invitation = await getPlayGroupInvitation(db, { invitationToken });
      return json(200, invitation);
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND") return json(404, { error: "invitation_unavailable" });
      return errorResponse(error, secure);
    }
  }

  async function join(request: Request) {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    const cookie = readCookie(request);
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let body: Record<string, unknown> | null;
    try { body = await readJson(request); } catch { return json(400, { error: "invalid_request" }); }
    if (!body || Object.keys(body).length !== 2 || !invitationInput(body.invitationToken) || typeof body.consent !== "boolean") return json(400, { error: "invalid_request" });
    const invitationToken = body.invitationToken as string;
    if (!body.consent) return json(400, { error: "consent_required" });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-join", cookie.kind === "valid" ? cookie.token : invitationToken, 120);
      if (limited) return limited;
      const joined = await joinPlayGroup(db, {
        invitationToken,
        ...(cookie.kind === "valid" ? { participantToken: cookie.token } : {}),
        consent: true,
      });
      const state = await getPlayGroupState(db, { participantToken: joined.participantToken });
      return json(joined.resumed ? 200 : 201, {
        status: joined.resumed ? "resumed" : "joined", room: { status: state.status, expiresAt: state.expiresAt },
      }, { token: joined.participantToken, maxAge: Math.floor((state.expiresAt.getTime() - Date.now()) / 1000), secure });
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND" && cookie.kind === "valid") return json(409, { error: "group_session_in_use" });
      return errorResponse(error, secure);
    }
  }

  async function current(request: Request) {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-current", cookie.token, 600);
      if (limited) return limited;
      const state = await getPlayGroupState(db, { participantToken: cookie.token });
      if (state.status === "expired" || state.status === "abandoned") return json(409, { error: "group_closed" }, { secure });
      return json(200, {
        status: state.status, ownStatus: state.ownAttemptStatus,
        ownAnsweredCount: state.ownAnsweredCount, otherJoined: state.otherJoined,
        otherCompleted: state.otherCompleted, expiresAt: state.expiresAt,
      });
    } catch (error) {
      return errorResponse(error, secure, { clearCookie: error instanceof DomainError && error.code === "NOT_FOUND" });
    }
  }

  async function questions(request: Request) {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-questions", cookie.token, 600);
      if (limited) return limited;
      const data = await getDuoQuestions(db, { participantToken: cookie.token });
      if (data.status === "abandoned") return json(409, { error: "attempt_closed" });
      return json(200, { status: data.status, ...questionsProjection(data) });
    } catch (error) {
      return errorResponse(error, secure, { clearCookie: error instanceof DomainError && error.code === "NOT_FOUND" });
    }
  }

  async function answer(request: Request) {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let body: Record<string, unknown> | null;
    try { body = await readJson(request); } catch { return json(400, { error: "invalid_request" }); }
    if (!body || Object.keys(body).length !== 2 || typeof body.cueKey !== "string" || body.cueKey.length < 1 || body.cueKey.length > 100 ||
      typeof body.optionIndex !== "number" || !Number.isInteger(body.optionIndex) || body.optionIndex < 0 || body.optionIndex > 2) return json(400, { error: "invalid_request" });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-answer", cookie.token, 120);
      if (limited) return limited;
      const owned = await getDuoQuestions(db, { participantToken: cookie.token });
      const previous = owned.submissions.find((submission) => submission.cueKey === body.cueKey);
      if (owned.status === "completed") {
        if (!owned.questions.some((question) => question.cueKey === body.cueKey)) return json(400, { error: "invalid_answer" });
        if (previous?.optionIndex === body.optionIndex) return json(200, { outcome: "duplicate", attempt: { status: "completed", answeredCount: owned.submissions.length } });
        if (previous) return json(409, { error: "answer_conflict" });
        return json(409, { error: "attempt_closed" });
      }
      const saved = await submitAnswer(db, { participantToken: cookie.token, cueKey: body.cueKey, optionIndex: body.optionIndex });
      const updated = await getDuoQuestions(db, { participantToken: cookie.token });
      return json(saved.outcome === "duplicate" || updated.status === "completed" ? 200 : 201, {
        outcome: saved.outcome,
        attempt: { status: updated.status, answeredCount: updated.submissions.length },
      });
    } catch (error) {
      return errorResponse(error, secure, { clearCookie: error instanceof DomainError && error.code === "NOT_FOUND" });
    }
  }

  async function result(request: Request) {
    const secure = secureRequest(request);
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-result", cookie.token, 600);
      if (limited) return limited;
      const data = await getPlayGroupResult(db, { participantToken: cookie.token });
      const questions = await getDuoQuestions(db, { participantToken: cookie.token });
      const details = questions.questions.map((question, index) => ({
        cueKey: question.cueKey,
        matched: data.ownAnswers[index] === data.partnerAnswers[index],
        yourOptionIndex: data.ownAnswers[index],
        friendOptionIndex: data.partnerAnswers[index],
      }));
      return json(200, { status: "completed", result: { matchedCount: data.matchedCount, total: data.total, message: data.message, questions: details } });
    } catch (error) {
      return errorResponse(error, secure, { clearCookie: error instanceof DomainError && error.code === "NOT_FOUND" });
    }
  }

  async function leave(request: Request) {
    const secure = secureRequest(request);
    if (!isTrustedSameOrigin(request, options.trustedOrigin)) return json(403, { error: "same_origin_required" });
    const cookie = readCookie(request);
    if (cookie.kind === "absent") return json(401, { error: "session_required" });
    if (cookie.kind === "invalid") return json(401, { error: "session_unavailable" }, { secure });
    let db: DomainDb;
    try { db = databaseProvider(); } catch { return json(503, { error: "service_unavailable" }); }
    try {
      const limited = await rateLimit(request, db, "duo-leave", cookie.token, 60);
      if (limited) return limited;
      await leavePlayGroup(db, { participantToken: cookie.token });
      return json(200, { status: "left" }, { secure });
    } catch (error) {
      return errorResponse(error, secure, { clearCookie: error instanceof DomainError && error.code === "NOT_FOUND" });
    }
  }

  return { create, preview, join, current, questions, answer, result, leave };
}
