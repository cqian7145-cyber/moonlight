import "server-only";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { DomainDb, findAvailablePublication } from "./db-scoped";
import { fail } from "./errors";
import { calculateDuoComparison } from "./results";
import { hashToken, newToken, ServiceDependencies, serviceNow } from "./tokens";
import { markExpiredGroup } from "./attempts";

const DEFAULT_GROUP_TTL = 15 * 60 * 1000;

export async function createPlayGroup(db: DomainDb, input: { venueId: string; tableId?: string; consent: boolean; ttlMs?: number }, dependencies?: ServiceDependencies) {
  if (!input.consent) fail("CONSENT_REQUIRED");
  const now = serviceNow(dependencies);
  const invitationToken = newToken(dependencies);
  const participantToken = newToken(dependencies);
  return db.transaction(async (tx) => {
    const activity = await findAvailablePublication(tx, input.venueId, now);
    if (input.tableId) {
      const [table] = await tx.select({ id: schema.venueTables.id }).from(schema.venueTables).where(and(
        eq(schema.venueTables.id, input.tableId), eq(schema.venueTables.venueId, input.venueId), eq(schema.venueTables.isEnabled, true),
      )).limit(1);
      if (!table) fail("ACTIVITY_UNAVAILABLE");
    }
    const ttl = input.ttlMs ?? DEFAULT_GROUP_TTL;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > DEFAULT_GROUP_TTL) fail("INVALID_REQUEST");
    const [group] = await tx.insert(schema.playGroups).values({
      venueId: input.venueId, publicationId: activity.publicationId, tableId: input.tableId ?? null,
      inviteCodeHash: hashToken(invitationToken), status: "open", expiresAt: new Date(now.getTime() + ttl), createdAt: now,
    }).returning({ id: schema.playGroups.id });
    const [attempt] = await tx.insert(schema.attempts).values({
      publicationId: activity.publicationId, playGroupId: group.id, mode: "duo", status: "in_progress",
      sessionTokenHash: hashToken(participantToken), consentedAt: now, startedAt: now,
    }).returning({ id: schema.attempts.id });
    return { groupId: group.id, attemptId: attempt.id, invitationToken, participantToken, expiresAt: new Date(now.getTime() + ttl), resumed: false };
  });
}

export async function joinPlayGroup(db: DomainDb, input: { invitationToken: string; participantToken?: string; consent: boolean }, dependencies?: ServiceDependencies) {
  if (!input.consent) fail("CONSENT_REQUIRED");
  const now = serviceNow(dependencies);
  const participantToken = input.participantToken ?? newToken(dependencies);
  const invitationHash = hashToken(input.invitationToken);
  const participantHash = hashToken(participantToken);
  const outcome = await db.transaction(async (tx) => {
    const [group] = await tx.select({ id: schema.playGroups.id, venueId: schema.playGroups.venueId, publicationId: schema.playGroups.publicationId, status: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt })
      .from(schema.playGroups).where(eq(schema.playGroups.inviteCodeHash, invitationHash)).for("update").limit(1);
    if (!group) return { error: "NOT_FOUND" as const };
    if (await markExpiredGroup(tx, group.id, now)) return { error: "GROUP_EXPIRED" as const };
    if (group.status === "expired") return { error: "GROUP_EXPIRED" as const };
    if (group.status === "cancelled") return { error: "GROUP_CLOSED" as const };
    const [existing] = await tx.select({ id: schema.attempts.id, groupId: schema.attempts.playGroupId, status: schema.attempts.status })
      .from(schema.attempts).where(eq(schema.attempts.sessionTokenHash, participantHash)).limit(1);
    if (existing) {
      if (existing.groupId !== group.id || existing.status === "abandoned") return { error: "NOT_FOUND" as const };
      return { attemptId: existing.id, groupId: group.id, resumed: true };
    }
    if (input.participantToken !== undefined) return { error: "NOT_FOUND" as const };
    const current = await findAvailablePublication(tx, group.venueId, now);
    if (current.publicationId !== group.publicationId) return { error: "GROUP_CLOSED" as const };
    const members = await tx.select({ id: schema.attempts.id }).from(schema.attempts)
      .where(and(eq(schema.attempts.playGroupId, group.id), eq(schema.attempts.mode, "duo"), sql`${schema.attempts.status} <> 'abandoned'`));
    if (members.length >= 2) return { error: "GROUP_FULL" as const };
    const [groupRecord] = await tx.select({ publicationId: schema.playGroups.publicationId }).from(schema.playGroups).where(eq(schema.playGroups.id, group.id)).limit(1);
    if (!groupRecord) return { error: "NOT_FOUND" as const };
    const [attempt] = await tx.insert(schema.attempts).values({
      publicationId: groupRecord.publicationId, playGroupId: group.id, mode: "duo", status: "in_progress",
      sessionTokenHash: participantHash, consentedAt: now, startedAt: now,
    }).returning({ id: schema.attempts.id });
    await tx.update(schema.playGroups).set({ status: "paired" }).where(eq(schema.playGroups.id, group.id));
    return { attemptId: attempt.id, groupId: group.id, resumed: false };
  });
  if ("error" in outcome && outcome.error) fail(outcome.error);
  return { ...outcome, participantToken };
}

async function ownedDuo(db: DomainDb, token: string) {
  const query = db.select({
    attemptId: schema.attempts.id, groupId: schema.playGroups.id, publicationId: schema.playGroups.publicationId,
    groupStatus: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt, consentedAt: schema.attempts.consentedAt,
  }).from(schema.attempts).innerJoin(schema.playGroups, and(
    eq(schema.playGroups.id, schema.attempts.playGroupId), eq(schema.playGroups.publicationId, schema.attempts.publicationId),
  )).where(and(eq(schema.attempts.sessionTokenHash, hashToken(token)), eq(schema.attempts.mode, "duo"))).limit(1);
  const rows = await query;
  if (!rows[0]) fail("NOT_FOUND");
  return rows[0];
}

async function lockParticipantGroup(tx: DomainDb, token: string) {
  const [ref] = await tx.select({ groupId: schema.playGroups.id }).from(schema.attempts).innerJoin(schema.playGroups, and(
    eq(schema.playGroups.id, schema.attempts.playGroupId), eq(schema.playGroups.publicationId, schema.attempts.publicationId),
  )).where(and(eq(schema.attempts.sessionTokenHash, hashToken(token)), eq(schema.attempts.mode, "duo"))).limit(1);
  if (!ref) fail("NOT_FOUND");
  await tx.select({ id: schema.playGroups.id }).from(schema.playGroups).where(eq(schema.playGroups.id, ref.groupId)).for("update").limit(1);
  return ref.groupId;
}

export async function getPlayGroupState(db: DomainDb, input: { participantToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  const state = await db.transaction(async (tx) => {
    const groupId = await lockParticipantGroup(tx, input.participantToken);
    await markExpiredGroup(tx, groupId, now);
    const [group] = await tx.select({ status: schema.playGroups.status }).from(schema.playGroups).where(eq(schema.playGroups.id, groupId)).limit(1);
    if (!group) fail("NOT_FOUND");
    const members = await tx.select({ status: schema.attempts.status }).from(schema.attempts)
      .where(and(eq(schema.attempts.playGroupId, groupId), eq(schema.attempts.mode, "duo"), sql`${schema.attempts.status} <> 'abandoned'`));
    const complete = members.length === 2 && members.every((member) => member.status === "completed");
    return {
      groupId,
      status: group.status === "open" ? "waiting" as const : group.status === "paired" ? complete ? "completed" as const : "ready" as const : group.status === "expired" ? "expired" as const : "abandoned" as const,
      validMemberCount: members.length,
    };
  });
  return state;
}

export async function getPlayGroupResult(db: DomainDb, input: { participantToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  const outcome = await db.transaction(async (tx) => {
    const groupId = await lockParticipantGroup(tx, input.participantToken);
    const expired = await markExpiredGroup(tx, groupId, now);
    if (expired) return { error: "RESULT_NOT_READY" as const };
    const own = await ownedDuo(tx, input.participantToken);
    if (own.groupStatus !== "paired") return { error: "RESULT_NOT_READY" as const };
    const attempts = await tx.select({ id: schema.attempts.id, consentedAt: schema.attempts.consentedAt, status: schema.attempts.status })
      .from(schema.attempts).where(and(eq(schema.attempts.playGroupId, own.groupId), eq(schema.attempts.mode, "duo")));
    if (attempts.length !== 2 || attempts.some((attempt) => !attempt.consentedAt || attempt.status !== "completed")) return { error: "RESULT_NOT_READY" as const };
    const [version] = await tx.select({ content: schema.activityVersions.content }).from(schema.publications)
      .innerJoin(schema.activityVersions, and(eq(schema.activityVersions.id, schema.publications.versionId), eq(schema.activityVersions.venueId, schema.publications.venueId)))
      .where(eq(schema.publications.id, own.publicationId)).limit(1);
    if (!version) return { error: "RESULT_NOT_READY" as const };
    const members = [] as { answers: number[] }[];
    for (const attempt of attempts) {
      const rows = await tx.select({ cueKey: schema.submissions.cueKey, answer: schema.submissions.answer })
        .from(schema.submissions).where(eq(schema.submissions.attemptId, attempt.id));
      const answers = version.content.cues.map((cue) => {
        const answer = rows.find((row) => row.cueKey === cue.key)?.answer as { optionIndex?: number } | undefined;
        if (answer?.optionIndex === undefined) return null;
        return answer.optionIndex;
      });
      if (answers.some((answer) => answer === null)) return { error: "RESULT_NOT_READY" as const };
      members.push({ answers: answers as number[] });
    }
    const comparison = calculateDuoComparison(members[0]!.answers, members[1]!.answers);
    return { groupId: own.groupId, members, ...comparison };
  });
  if ("error" in outcome && outcome.error) fail(outcome.error);
  return outcome;
}

export async function leavePlayGroup(db: DomainDb, input: { participantToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  return db.transaction(async (tx) => {
    const groupId = await lockParticipantGroup(tx, input.participantToken);
    const own = await ownedDuo(tx, input.participantToken);
    const expired = await markExpiredGroup(tx, own.groupId, now);
    if (expired || own.groupStatus === "expired") return { status: "abandoned" as const };
    const [attempt] = await tx.select({ id: schema.attempts.id, status: schema.attempts.status }).from(schema.attempts)
      .where(eq(schema.attempts.id, own.attemptId)).for("update").limit(1);
    if (!attempt) fail("NOT_FOUND");
    if (attempt.status === "in_progress") await tx.update(schema.attempts).set({ status: "abandoned" }).where(eq(schema.attempts.id, attempt.id));
    const members = await tx.select({ status: schema.attempts.status }).from(schema.attempts)
      .where(and(eq(schema.attempts.playGroupId, groupId), eq(schema.attempts.mode, "duo")));
    const bothCompleted = members.length === 2 && members.every((member) => member.status === "completed");
    if (!bothCompleted && own.groupStatus !== "cancelled") {
      await tx.update(schema.playGroups).set({ status: "cancelled" }).where(eq(schema.playGroups.id, groupId));
      await tx.update(schema.attempts).set({ status: "abandoned" }).where(and(
        eq(schema.attempts.playGroupId, groupId), eq(schema.attempts.status, "in_progress"),
      ));
    }
    return { status: "abandoned" as const };
  });
}
