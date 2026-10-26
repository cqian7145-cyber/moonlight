import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import { hashToken, newToken } from "./tokens";
import { merchantJson } from "./merchant-api";
import type { MerchantAuthDb } from "../lib/merchant-auth";
import type { createMerchantAuth } from "../lib/merchant-auth";
import { requireVenueMember, requireVenueOwner } from "./venue-auth";

type MerchantAuth = ReturnType<typeof createMerchantAuth>;

const draftInput = z.object({
  title: z.string().trim().min(1).max(160),
  cues: z.array(z.object({
    prompt: z.string().trim().min(1).max(180),
    choices: z.array(z.string().trim().min(1).max(80)).length(3),
  }).strict()).length(3),
}).strict();

const venueIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Options = { publicOrigin: string; now?: () => Date; createCode?: () => string };

function validPublicOrigin(value: string) {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((!loopback && parsed.protocol !== "https:") || parsed.origin !== value || parsed.pathname !== "/") {
    throw new Error("A trusted public HTTPS origin is required outside localhost.");
  }
  return parsed.origin;
}

function writeOriginAllowed(request: Request, trustedOrigin: string) {
  const expected = new URL(trustedOrigin);
  return request.headers.get("origin") === expected.origin && request.headers.get("host")?.toLowerCase() === expected.host.toLowerCase();
}

async function readJson(request: Request, maximum = 32_768): Promise<unknown | null> {
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maximum) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function accessStatus(kind: "unauthenticated" | "forbidden") {
  return kind === "unauthenticated" ? 401 : 403;
}

function makeDraft(content: z.infer<typeof draftInput>, previous?: schema.ActivityDraftContent | null): schema.ActivityDraftContent {
  return { title: content.title, cues: content.cues.map((cue, index) => ({
    key: previous?.cues[index]?.key ?? `question-${index + 1}`,
    prompt: cue.prompt,
    choices: cue.choices,
  })) };
}

export function createMerchantOperationsHandlers(db: MerchantAuthDb, auth: MerchantAuth, options: Options) {
  const publicOrigin = validPublicOrigin(options.publicOrigin);
  const now = options.now ?? (() => new Date());
  const createCode = options.createCode ?? newToken;

  async function ownerAccess(request: Request, venueId: string) {
    if (!venueIdPattern.test(venueId)) return { kind: "forbidden" as const };
    return requireVenueOwner(db, auth, request.headers, venueId);
  }

  async function memberAccess(request: Request, venueId: string) {
    if (!venueIdPattern.test(venueId)) return { kind: "forbidden" as const };
    return requireVenueMember(db, auth, request.headers, venueId);
  }

  async function listActivities(request: Request, venueId: string) {
    try {
      const access = await memberAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const templates = await db.select().from(schema.activityTemplates)
        .where(eq(schema.activityTemplates.venueId, venueId)).orderBy(desc(schema.activityTemplates.updatedAt));
      const versions = await db.select({
        id: schema.activityVersions.id,
        templateId: schema.activityVersions.templateId,
        versionNo: schema.activityVersions.versionNo,
        title: schema.activityVersions.content,
        createdAt: schema.activityVersions.createdAt,
      }).from(schema.activityVersions).where(eq(schema.activityVersions.venueId, venueId))
        .orderBy(desc(schema.activityVersions.versionNo));
      const active = await db.select({ id: schema.publications.id, versionId: schema.publications.versionId })
        .from(schema.publications).where(and(eq(schema.publications.venueId, venueId), eq(schema.publications.status, "active"))).limit(1);
      if (access.venue.role === "staff") {
        const activeActivity = active[0] ? await db.select({
          publicationId: schema.publications.id, versionId: schema.activityVersions.id,
          versionNo: schema.activityVersions.versionNo, content: schema.activityVersions.content,
        }).from(schema.publications).innerJoin(schema.activityVersions, eq(schema.activityVersions.id, schema.publications.versionId))
          .where(eq(schema.publications.id, active[0].id)).limit(1) : [];
        const content = activeActivity[0]?.content as schema.ActivityContent | undefined;
        return merchantJson(200, {
          role: access.venue.role, templates: [], currentPublicationId: active[0]?.id ?? null,
          currentActivity: activeActivity[0] ? {
            publicationId: activeActivity[0].publicationId, versionId: activeActivity[0].versionId,
            versionNo: activeActivity[0].versionNo, title: content?.title ?? "已发布活动",
            questionCount: content?.cues.length ?? 0,
          } : null,
        });
      }
      return merchantJson(200, {
        role: access.venue.role,
        templates: templates.map((template) => ({
          id: template.id, title: template.draftContent?.title ?? template.title, status: template.status, updatedAt: template.updatedAt,
          draftContent: template.draftContent,
          versions: versions.filter((version) => version.templateId === template.id).map((version) => ({
            id: version.id, versionNo: version.versionNo, title: (version.title as { title?: string }).title ?? template.title,
            active: active[0]?.versionId === version.id, createdAt: version.createdAt,
          })),
        })),
        currentPublicationId: active[0]?.id ?? null,
      });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function draft(request: Request, venueId: string, templateId: string) {
    try {
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const [template] = await db.select().from(schema.activityTemplates).where(and(
        eq(schema.activityTemplates.id, templateId), eq(schema.activityTemplates.venueId, venueId),
      )).limit(1);
      if (!template) return merchantJson(404, { error: "activity_not_found" });
      return merchantJson(200, { template: { id: template.id, title: template.draftContent?.title ?? template.title, status: template.status, draftContent: template.draftContent } });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function createDraft(request: Request, venueId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = draftInput.safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "invalid_activity_draft" });
      const [template] = await db.insert(schema.activityTemplates).values({
        venueId, title: parsed.data.title, status: "draft", draftContent: makeDraft(parsed.data), updatedAt: now(),
      }).returning();
      return merchantJson(201, { template: { id: template!.id, title: template!.draftContent!.title, status: template!.status, draftContent: template!.draftContent } });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function updateDraft(request: Request, venueId: string, templateId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = draftInput.safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "invalid_activity_draft" });
      const result = await db.transaction(async (tx) => {
        const [template] = await tx.select().from(schema.activityTemplates).where(and(
          eq(schema.activityTemplates.id, templateId), eq(schema.activityTemplates.venueId, venueId),
        )).for("update").limit(1);
        if (!template || template.status === "archived") return null;
        const draftContent = makeDraft(parsed.data, template.draftContent);
        const [updated] = await tx.update(schema.activityTemplates).set({
        draftContent, updatedAt: now(),
        }).where(eq(schema.activityTemplates.id, template.id)).returning();
        return updated;
      });
      if (!result) return merchantJson(404, { error: "activity_not_found" });
      return merchantJson(200, { template: { id: result.id, title: result.draftContent?.title ?? result.title, status: result.status, draftContent: result.draftContent } });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function publish(request: Request, venueId: string, templateId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const body = await readJson(request);
      const expected = z.object({ expectedCurrentPublicationId: z.string().uuid().nullable() }).strict().safeParse(body);
      if (!expected.success) return merchantJson(400, { error: "invalid_request" });

      const result = await db.transaction(async (tx) => {
        const [venue] = await tx.select({ id: schema.venues.id }).from(schema.venues)
          .where(eq(schema.venues.id, venueId)).for("update").limit(1);
        if (!venue) return { kind: "not_found" as const };
        const [membership] = await tx.select({ id: schema.venueMembers.id }).from(schema.venueMembers).where(and(
          eq(schema.venueMembers.venueId, venueId), eq(schema.venueMembers.userId, access.user.id),
          eq(schema.venueMembers.role, "owner"), eq(schema.venueMembers.status, "active"),
        )).for("update").limit(1);
        if (!membership) return { kind: "forbidden" as const };
        const [template] = await tx.select().from(schema.activityTemplates).where(and(
          eq(schema.activityTemplates.id, templateId), eq(schema.activityTemplates.venueId, venueId),
        )).for("update").limit(1);
        if (!template || template.status === "archived" || !template.draftContent) return { kind: "not_found" as const };
        const [current] = await tx.select({ id: schema.publications.id }).from(schema.publications).where(and(
          eq(schema.publications.venueId, venueId), eq(schema.publications.status, "active"),
        )).limit(1);
        if ((current?.id ?? null) !== expected.data.expectedCurrentPublicationId) return { kind: "conflict" as const };
        const content = { title: template.draftContent.title, cues: template.draftContent.cues };
        const valid = draftInput.safeParse({ title: content.title, cues: content.cues.map(({ prompt, choices }) => ({ prompt, choices })) });
        if (!valid.success || new Set(content.cues.map((cue) => cue.key)).size !== 3) return { kind: "invalid" as const };
        const [{ max: highestVersion }] = await tx.select({ max: max(schema.activityVersions.versionNo) })
          .from(schema.activityVersions).where(eq(schema.activityVersions.templateId, templateId));
        const at = now();
        if (current) {
          const [old] = await tx.select({ activatedAt: schema.publications.activatedAt }).from(schema.publications)
            .where(eq(schema.publications.id, current.id)).limit(1);
          const deactivatedAt = new Date(Math.max(at.getTime(), old?.activatedAt.getTime() ?? 0));
          await tx.update(schema.publications).set({ status: "inactive", deactivatedAt }).where(eq(schema.publications.id, current.id));
        }
        const [version] = await tx.insert(schema.activityVersions).values({
          venueId, templateId, versionNo: (highestVersion ?? 0) + 1, content,
        }).returning({ id: schema.activityVersions.id, versionNo: schema.activityVersions.versionNo });
        const [publication] = await tx.insert(schema.publications).values({
          venueId, versionId: version!.id, status: "active", activatedAt: at,
        }).returning({ id: schema.publications.id, versionId: schema.publications.versionId, activatedAt: schema.publications.activatedAt });
        return { kind: "published" as const, publication, versionNo: version!.versionNo };
      });
      if (result.kind === "conflict") return merchantJson(409, { error: "publication_changed_refresh_and_retry" });
      if (result.kind === "forbidden") return merchantJson(403, { error: "venue_access_denied" });
      if (result.kind === "not_found") return merchantJson(404, { error: "draft_not_found" });
      if (result.kind === "invalid") return merchantJson(400, { error: "invalid_activity_draft" });
      return merchantJson(201, { publication: result.publication, versionNo: result.versionNo });
    } catch (error) {
      if (typeof error === "object" && error !== null && "cause" in error && (error as { cause?: { code?: string } }).cause?.code === "23505") {
        return merchantJson(409, { error: "publication_changed_refresh_and_retry" });
      }
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function unpublish(request: Request, venueId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = z.object({ expectedCurrentPublicationId: z.string().uuid() }).strict().safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "invalid_request" });
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: schema.venues.id }).from(schema.venues).where(eq(schema.venues.id, venueId)).for("update").limit(1);
        const [membership] = await tx.select({ id: schema.venueMembers.id }).from(schema.venueMembers).where(and(
          eq(schema.venueMembers.venueId, venueId), eq(schema.venueMembers.userId, access.user.id),
          eq(schema.venueMembers.role, "owner"), eq(schema.venueMembers.status, "active"),
        )).for("update").limit(1);
        if (!membership) return "forbidden" as const;
        const [current] = await tx.select({ id: schema.publications.id, activatedAt: schema.publications.activatedAt }).from(schema.publications).where(and(
          eq(schema.publications.id, parsed.data.expectedCurrentPublicationId), eq(schema.publications.venueId, venueId), eq(schema.publications.status, "active"),
        )).limit(1);
        if (!current) return "conflict" as const;
        const deactivatedAt = new Date(Math.max(now().getTime(), current.activatedAt.getTime()));
        await tx.update(schema.publications).set({ status: "inactive", deactivatedAt }).where(eq(schema.publications.id, current.id));
        return "unpublished" as const;
      });
      if (result === "forbidden") return merchantJson(403, { error: "venue_access_denied" });
      if (result === "conflict") return merchantJson(409, { error: "publication_changed_refresh_and_retry" });
      return merchantJson(200, { status: "inactive", notice: "已下架的活动不会用于新参与；已开始的参与仍可按原题包继续。普通下架不会紧急撤回正在进行的题目。" });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function publication(request: Request, venueId: string) {
    try {
      const access = await memberAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const rows = await db.select({
        id: schema.publications.id, status: schema.publications.status, versionId: schema.activityVersions.id,
        versionNo: schema.activityVersions.versionNo, content: schema.activityVersions.content,
        activatedAt: schema.publications.activatedAt, deactivatedAt: schema.publications.deactivatedAt,
      }).from(schema.publications).innerJoin(schema.activityVersions, eq(schema.activityVersions.id, schema.publications.versionId))
        .where(access.venue.role === "owner"
          ? eq(schema.publications.venueId, venueId)
          : and(eq(schema.publications.venueId, venueId), eq(schema.publications.status, "active")))
        .orderBy(desc(schema.publications.activatedAt));
      return merchantJson(200, { role: access.venue.role, publications: rows.map(({ content, ...row }) => ({
        ...row, title: (content as schema.ActivityContent).title ?? "已发布活动", questionCount: (content as schema.ActivityContent).cues.length,
      })) });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function tables(request: Request, venueId: string) {
    try {
      const access = await memberAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const rows = await db.select({ id: schema.venueTables.id, name: schema.venueTables.name, isEnabled: schema.venueTables.isEnabled, createdAt: schema.venueTables.createdAt })
        .from(schema.venueTables).where(eq(schema.venueTables.venueId, venueId)).orderBy(schema.venueTables.name);
      return merchantJson(200, { role: access.venue.role, tables: rows });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function createTable(request: Request, venueId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = z.object({ name: z.string().trim().min(1).max(80) }).strict().safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "invalid_table_name" });
      const code = createCode();
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return merchantJson(503, { error: "merchant_service_unavailable" });
      const [table] = await db.insert(schema.venueTables).values({ venueId, name: parsed.data.name, publicCodeHash: hashToken(code) }).returning({
        id: schema.venueTables.id, venueId: schema.venueTables.venueId, name: schema.venueTables.name,
        isEnabled: schema.venueTables.isEnabled, createdAt: schema.venueTables.createdAt,
      });
      return merchantJson(201, { table, tableCode: code, printUrl: new URL(`/t/${code}`, publicOrigin).toString() });
    } catch (error) {
      if (typeof error === "object" && error !== null && "cause" in error && (error as { cause?: { code?: string } }).cause?.code === "23505") {
        return merchantJson(503, { error: "merchant_service_unavailable" });
      }
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function setTableEnabled(request: Request, venueId: string, tableId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "invalid_request" });
      const [table] = await db.update(schema.venueTables).set({ isEnabled: parsed.data.enabled }).where(and(
        eq(schema.venueTables.id, tableId), eq(schema.venueTables.venueId, venueId),
      )).returning({ id: schema.venueTables.id, name: schema.venueTables.name, isEnabled: schema.venueTables.isEnabled });
      if (!table) return merchantJson(404, { error: "table_not_found" });
      return merchantJson(200, { table });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  async function rotateTableCode(request: Request, venueId: string, tableId: string) {
    try {
      if (!writeOriginAllowed(request, publicOrigin)) return merchantJson(403, { error: "same_origin_required" });
      const access = await ownerAccess(request, venueId);
      if (access.kind !== "allowed") return merchantJson(accessStatus(access.kind), { error: access.kind === "unauthenticated" ? "authentication_required" : "venue_access_denied" });
      const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(await readJson(request));
      if (!parsed.success) return merchantJson(400, { error: "rotation_confirmation_required" });
      const code = createCode();
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return merchantJson(503, { error: "merchant_service_unavailable" });
      const [table] = await db.update(schema.venueTables).set({ publicCodeHash: hashToken(code) }).where(and(
        eq(schema.venueTables.id, tableId), eq(schema.venueTables.venueId, venueId),
      )).returning({ id: schema.venueTables.id, venueId: schema.venueTables.venueId, name: schema.venueTables.name, isEnabled: schema.venueTables.isEnabled });
      if (!table) return merchantJson(404, { error: "table_not_found" });
      return merchantJson(200, { table, tableCode: code, printUrl: new URL(`/t/${code}`, publicOrigin).toString() });
    } catch {
      return merchantJson(503, { error: "merchant_service_unavailable" });
    }
  }

  return { listActivities, draft, createDraft, updateDraft, publish, unpublish, publication, tables, createTable, setTableEnabled, rotateTableCode };
}
