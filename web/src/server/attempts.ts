import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { calculateSoloResult, type SoloResult } from "../features/solo/calculate-solo-result";
import * as schema from "../db/schema";
import { ActivityLocator, getCurrentActivity } from "./activities";
import { DomainDb } from "./db-scoped";
import { fail } from "./errors";
import { hashToken, newToken, ServiceDependencies, serviceNow } from "./tokens";

export async function startSoloAttempt(db: DomainDb, input: ActivityLocator & { participantToken?: string }, dependencies?: ServiceDependencies) {
  const token = input.participantToken ?? newToken(dependencies);
  const tokenHash = hashToken(token);
  const now = serviceNow(dependencies);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: schema.attempts.id, venueId: schema.publications.venueId })
      .from(schema.attempts).innerJoin(schema.publications, eq(schema.publications.id, schema.attempts.publicationId))
      .where(eq(schema.attempts.sessionTokenHash, tokenHash)).limit(1);
    if (existing) {
      if (existing.venueId !== input.venueId || (await tx.select({ id: schema.attempts.id }).from(schema.attempts)
        .where(and(eq(schema.attempts.id, existing.id), eq(schema.attempts.mode, "solo"))).limit(1)).length === 0) fail("NOT_FOUND");
      return { attemptId: existing.id, participantToken: token, resumed: true };
    }
    if (input.participantToken !== undefined) fail("NOT_FOUND");
    const activity = await getCurrentActivity(tx, input, { clock: () => now });
    const [attempt] = await tx.insert(schema.attempts).values({
      publicationId: activity.publicationId, mode: "solo", sessionTokenHash: tokenHash, startedAt: now,
    }).returning({ id: schema.attempts.id });
    return { attemptId: attempt.id, participantToken: token, resumed: false };
  });
}

async function findOwnedAttempt(db: DomainDb, token: string, lock = false, venueId?: string) {
  const q = db.select({
    id: schema.attempts.id, publicationId: schema.attempts.publicationId, playGroupId: schema.attempts.playGroupId,
    mode: schema.attempts.mode, status: schema.attempts.status, consentedAt: schema.attempts.consentedAt,
    startedAt: schema.attempts.startedAt, completedAt: schema.attempts.completedAt,
    venueId: schema.publications.venueId, versionId: schema.publications.versionId, content: schema.activityVersions.content,
    activityTitle: schema.activityTemplates.title,
  }).from(schema.attempts)
    .innerJoin(schema.publications, eq(schema.publications.id, schema.attempts.publicationId))
    .innerJoin(schema.activityVersions, and(
      eq(schema.activityVersions.id, schema.publications.versionId),
      eq(schema.activityVersions.venueId, schema.publications.venueId),
    ))
    .innerJoin(schema.activityTemplates, and(
      eq(schema.activityTemplates.id, schema.activityVersions.templateId),
      eq(schema.activityTemplates.venueId, schema.activityVersions.venueId),
    ))
    .where(venueId === undefined
      ? eq(schema.attempts.sessionTokenHash, hashToken(token))
      : and(eq(schema.attempts.sessionTokenHash, hashToken(token)), eq(schema.publications.venueId, venueId)))
    .limit(1);
  const rows = await (lock ? q.for("update") : q);
  if (!rows[0]) fail("NOT_FOUND");
  return rows[0];
}

export async function getAttemptProgress(db: DomainDb, input: { participantToken: string; venueId?: string }) {
  const attempt = await findOwnedAttempt(db, input.participantToken, false, input.venueId);
  const rows = await db.select({ cueKey: schema.submissions.cueKey, answer: schema.submissions.answer, createdAt: schema.submissions.createdAt })
    .from(schema.submissions).where(eq(schema.submissions.attemptId, attempt.id));
  return {
    attemptId: attempt.id, mode: attempt.mode, status: attempt.status,
    startedAt: attempt.startedAt, completedAt: attempt.completedAt,
    activity: { title: attempt.activityTitle, questionCount: attempt.content.cues.length },
    submissions: rows.map((row) => ({ cueKey: row.cueKey, optionIndex: (row.answer as { optionIndex: number }).optionIndex, createdAt: row.createdAt })),
  };
}

export async function submitAnswer(db: DomainDb, input: { participantToken: string; cueKey: string; optionIndex: number }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  const outcome = await db.transaction(async (tx) => {
    const [tokenAttempt] = await tx.select({ playGroupId: schema.attempts.playGroupId, mode: schema.attempts.mode })
      .from(schema.attempts).where(eq(schema.attempts.sessionTokenHash, hashToken(input.participantToken))).limit(1);
    if (!tokenAttempt) fail("NOT_FOUND");
    if (tokenAttempt.mode === "duo" && tokenAttempt.playGroupId) {
      await tx.select({ id: schema.playGroups.id }).from(schema.playGroups)
        .where(eq(schema.playGroups.id, tokenAttempt.playGroupId)).for("update").limit(1);
    }
    const attempt = await findOwnedAttempt(tx, input.participantToken, true);
    if (attempt.status !== "in_progress") fail("ATTEMPT_CLOSED");
    if (!Array.isArray(attempt.content.cues) || attempt.content.cues.length !== 3) fail("ACTIVITY_UNAVAILABLE");
    if (attempt.mode === "duo") {
      if (!attempt.playGroupId) fail("ATTEMPT_CLOSED");
      const expired = await markExpiredGroup(tx, attempt.playGroupId, now);
      if (expired) return { error: "ATTEMPT_CLOSED" as const };
      const [group] = await tx.select({ status: schema.playGroups.status }).from(schema.playGroups)
        .where(eq(schema.playGroups.id, attempt.playGroupId)).limit(1);
      if (!group || group.status === "expired" || group.status === "cancelled") return { error: "ATTEMPT_CLOSED" as const };
    }
    const cues = attempt.content.cues;
    const cue = cues.find((item) => item.key === input.cueKey);
    if (!cue || !Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex >= cue.choices.length) fail("INVALID_ANSWER");
    const [inserted] = await tx.insert(schema.submissions).values({
      attemptId: attempt.id, cueKey: cue.key, answer: { optionIndex: input.optionIndex }, createdAt: now,
    }).onConflictDoNothing({ target: [schema.submissions.attemptId, schema.submissions.cueKey] }).returning({ id: schema.submissions.id });
    if (!inserted) {
      const [existing] = await tx.select({ answer: schema.submissions.answer }).from(schema.submissions)
        .where(and(eq(schema.submissions.attemptId, attempt.id), eq(schema.submissions.cueKey, cue.key))).limit(1);
      if ((existing?.answer as { optionIndex?: number } | undefined)?.optionIndex !== input.optionIndex) fail("ANSWER_CONFLICT");
      return { outcome: "duplicate" as const, attemptId: attempt.id, status: "in_progress" as const };
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.submissions)
      .where(eq(schema.submissions.attemptId, attempt.id));
    if (count === cues.length) {
      await tx.update(schema.attempts).set({ status: "completed", completedAt: now })
        .where(and(eq(schema.attempts.id, attempt.id), eq(schema.attempts.status, "in_progress")));
      return { outcome: "created" as const, attemptId: attempt.id, status: "completed" as const };
    }
    return { outcome: "created" as const, attemptId: attempt.id, status: "in_progress" as const };
  });
  if ("error" in outcome && outcome.error) fail(outcome.error);
  return outcome;
}

export async function getSoloResult(db: DomainDb, input: { participantToken: string }) {
  const attempt = await findOwnedAttempt(db, input.participantToken);
  if (attempt.mode !== "solo" || attempt.status !== "completed") fail("RESULT_NOT_READY");
  const submissions = await db.select({ cueKey: schema.submissions.cueKey, answer: schema.submissions.answer })
    .from(schema.submissions).where(eq(schema.submissions.attemptId, attempt.id));
  const answers = attempt.content.cues.map((cue) => {
    const answer = submissions.find((row) => row.cueKey === cue.key)?.answer as { optionIndex?: number } | undefined;
    if (answer?.optionIndex === undefined) fail("RESULT_NOT_READY");
    return answer.optionIndex;
  });
  const result: SoloResult = calculateSoloResult(answers);
  return { attemptId: attempt.id, result };
}

export async function abandonAttempt(db: DomainDb, input: { participantToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  return db.transaction(async (tx) => {
    const attempt = await findOwnedAttempt(tx, input.participantToken, true);
    if (attempt.mode !== "solo") fail("INVALID_REQUEST");
    if (attempt.status === "in_progress") await tx.update(schema.attempts).set({ status: "abandoned" }).where(eq(schema.attempts.id, attempt.id));
    return { attemptId: attempt.id, status: attempt.status === "completed" ? "completed" as const : "abandoned" as const, changedAt: now };
  });
}

export async function markExpiredGroup(tx: DomainDb, groupId: string, now: Date) {
  const [group] = await tx.select({ status: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt })
    .from(schema.playGroups).where(eq(schema.playGroups.id, groupId)).limit(1);
  if (group && (group.status === "open" || group.status === "paired") && group.expiresAt <= now) {
    await tx.update(schema.playGroups).set({ status: "expired" }).where(eq(schema.playGroups.id, groupId));
    await tx.update(schema.attempts).set({ status: "abandoned" }).where(and(
      eq(schema.attempts.playGroupId, groupId), eq(schema.attempts.status, "in_progress"),
    ));
    return true;
  }
  return false;
}
