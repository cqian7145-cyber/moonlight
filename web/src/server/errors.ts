import "server-only";

export type DomainErrorCode =
  | "ACTIVITY_UNAVAILABLE" | "CONSENT_REQUIRED" | "NOT_FOUND" | "INVALID_ANSWER"
  | "ANSWER_CONFLICT" | "ATTEMPT_CLOSED" | "GROUP_FULL" | "GROUP_EXPIRED"
  | "GROUP_CLOSED" | "RESULT_NOT_READY" | "INVALID_REQUEST" | "INVITE_UNAVAILABLE";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
  }
}

export function fail(code: DomainErrorCode): never {
  throw new DomainError(code);
}
