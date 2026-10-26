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
    const [group] = await tx.select({ id: schema.playGroups.id, venueId: schema.playGroups.venueId, publicationId: schema.playGroups.publicationId, tableId: schema.playGroups.tableId, status: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt })
      .from(schema.playGroups).where(eq(schema.playGroups.inviteCodeHash, invitationHash)).for("update").limit(1);
    if (!group) return { error: "NOT_FOUND" as const };
    if (await markExpiredGroup(tx, group.id, now)) return { error: "GROUP_EXPIRED" as const };
    if (group.status === "expired") return { error: "GROUP_EXPIRED" as const };
    if (group.status === "cancelled") return { error: "GROUP_CLOSED" as const };
    if (group.tableId) {
      const [table] = await tx.select({ isEnabled: schema.venueTables.isEnabled }).from(schema.venueTables)
        .where(eq(schema.venueTables.id, group.tableId)).limit(1);
      if (!table?.isEnabled) return { error: "GROUP_CLOSED" as const };
    }
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

export async function getPlayGroupInvitation(db: DomainDb, input: { invitationToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  const [room] = await db.select({
    status: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt,
    tableId: schema.playGroups.tableId, tableEnabled: schema.venueTables.isEnabled,
    venueStatus: schema.venues.status, venueName: schema.venues.name,
    publicationStatus: schema.publications.status, activatedAt: schema.publications.activatedAt,
    deactivatedAt: schema.publications.deactivatedAt, activityTitle: schema.activityTemplates.title,
    templateStatus: schema.activityTemplates.status,
  }).from(schema.playGroups)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.playGroups.venueId))
    .innerJoin(schema.publications, and(eq(schema.publications.id, schema.playGroups.publicationId), eq(schema.publications.venueId, schema.playGroups.venueId)))
    .innerJoin(schema.activityVersions, and(eq(schema.activityVersions.id, schema.publications.versionId), eq(schema.activityVersions.venueId, schema.publications.venueId)))
    .innerJoin(schema.activityTemplates, and(eq(schema.activityTemplates.id, schema.activityVersions.templateId), eq(schema.activityTemplates.venueId, schema.activityVersions.venueId)))
    .leftJoin(schema.venueTables, eq(schema.venueTables.id, schema.playGroups.tableId))
    .where(eq(schema.playGroups.inviteCodeHash, hashToken(input.invitationToken))).limit(1);
  if (!room) fail("NOT_FOUND");
  if (room.venueStatus !== "active" || (room.tableId !== null && room.tableEnabled !== true) || room.publicationStatus !== "active" || room.deactivatedAt !== null || room.activatedAt > now || room.templateStatus === "archived") fail("ACTIVITY_UNAVAILABLE");
  if (room.expiresAt <= now || room.status === "expired") fail("GROUP_EXPIRED");
  if (room.status !== "open") fail("GROUP_FULL");
  return { venueName: room.venueName, activityTitle: room.activityTitle, expiresAt: room.expiresAt };
}

export async function getPlayGroupScope(db: DomainDb, input: { participantToken: string }) {
  const [scope] = await db.select({ venueId: schema.playGroups.venueId, tableId: schema.playGroups.tableId })
    .from(schema.attempts).innerJoin(schema.playGroups, and(
      eq(schema.playGroups.id, schema.attempts.playGroupId), eq(schema.playGroups.publicationId, schema.attempts.publicationId),
    )).where(and(eq(schema.attempts.sessionTokenHash, hashToken(input.participantToken)), eq(schema.attempts.mode, "duo"))).limit(1);
  if (!scope) fail("NOT_FOUND");
  return scope;
}

async function ownedDuo(db: DomainDb, token: string) {
  const query = db.select({
    attemptId: schema.attempts.id, groupId: schema.playGroups.id, publicationId: schema.playGroups.publicationId,
    groupStatus: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt, consentedAt: schema.attempts.consentedAt,
    venueStatus: schema.venues.status, tableId: schema.playGroups.tableId, tableEnabled: schema.venueTables.isEnabled,
  }).from(schema.attempts).innerJoin(schema.playGroups, and(
    eq(schema.playGroups.id, schema.attempts.playGroupId), eq(schema.playGroups.publicationId, schema.attempts.publicationId),
  )).innerJoin(schema.venues, eq(schema.venues.id, schema.playGroups.venueId))
    .leftJoin(schema.venueTables, eq(schema.venueTables.id, schema.playGroups.tableId))
    .where(and(eq(schema.attempts.sessionTokenHash, hashToken(token)), eq(schema.attempts.mode, "duo"))).limit(1);
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
    const [group] = await tx.select({ status: schema.playGroups.status, expiresAt: schema.playGroups.expiresAt }).from(schema.playGroups).where(eq(schema.playGroups.id, groupId)).limit(1);
    if (!group) fail("NOT_FOUND");
    const own = await ownedDuo(tx, input.participantToken);
    if (own.venueStatus !== "active" || (own.tableId !== null && own.tableEnabled !== true)) fail("ACTIVITY_UNAVAILABLE");
    const expired = group.status === "expired" || group.expiresAt <= now;
    const members = expired ? [] : await tx.select({ id: schema.attempts.id, status: schema.attempts.status }).from(schema.attempts)
      .where(and(eq(schema.attempts.playGroupId, groupId), eq(schema.attempts.mode, "duo"), sql`${schema.attempts.status} <> 'abandoned'`));
    const complete = members.length === 2 && members.every((member) => member.status === "completed");
    const other = members.find((member) => member.id !== own.attemptId);
    const [{ ownAnsweredCount }] = await tx.select({ ownAnsweredCount: sql<number>`count(*)::int` }).from(schema.submissions)
      .where(eq(schema.submissions.attemptId, own.attemptId));
    const [expiry] = await tx.select({ expiresAt: schema.playGroups.expiresAt }).from(schema.playGroups).where(eq(schema.playGroups.id, groupId)).limit(1);
    return {
      groupId,
      status: expired ? "expired" as const : group.status === "open" ? "waiting" as const : group.status === "paired" ? complete ? "completed" as const : "ready" as const : "abandoned" as const,
      validMemberCount: members.length,
      ownAttemptStatus: expired ? "abandoned" : members.find((member) => member.id === own.attemptId)?.status ?? "abandoned",
      ownAnsweredCount,
      otherJoined: Boolean(other),
      otherCompleted: other?.status === "completed",
      expiresAt: expiry?.expiresAt ?? now,
    };
  });
  return state;
}

export async function getPlayGroupResult(db: DomainDb, input: { participantToken: string }, dependencies?: Pick<ServiceDependencies, "clock">) {
  const now = serviceNow(dependencies);
  const outcome = await db.transaction(async (tx) => {
    await lockParticipantGroup(tx, input.participantToken);
    const own = await ownedDuo(tx, input.participantToken);
    if (own.venueStatus !== "active" || (own.tableId !== null && own.tableEnabled !== true)) return { error: "ACTIVITY_UNAVAILABLE" as const };
    if (own.expiresAt <= now || own.groupStatus === "expired" || own.groupStatus === "cancelled") return { error: "RESULT_NOT_READY" as const };
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
    const ownIndex = attempts.findIndex((attempt) => attempt.id === own.attemptId);
    return {
      groupId: own.groupId, members, ...comparison,
      ownAnswers: members[ownIndex]!.answers,
      partnerAnswers: members[1 - ownIndex]!.answers,
    };
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
