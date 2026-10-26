import "server-only";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import * as schema from "../db/schema";
import { fail } from "./errors";

export type DomainDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>;

export async function findAvailablePublication(db: DomainDb, venueId: string, now: Date) {
  const [row] = await db.select({
    venueId: schema.venues.id,
    venueStatus: schema.venues.status,
    publicationId: schema.publications.id,
    publicationStatus: schema.publications.status,
    activatedAt: schema.publications.activatedAt,
    deactivatedAt: schema.publications.deactivatedAt,
    versionId: schema.activityVersions.id,
    content: schema.activityVersions.content,
    title: sql<string>`coalesce(${schema.activityVersions.content}->>'title', ${schema.activityTemplates.title})`,
    templateStatus: schema.activityTemplates.status,
  })
    .from(schema.publications)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.publications.venueId))
    .innerJoin(schema.activityVersions, and(
      eq(schema.activityVersions.id, schema.publications.versionId),
      eq(schema.activityVersions.venueId, schema.publications.venueId),
    ))
    .innerJoin(schema.activityTemplates, and(
      eq(schema.activityTemplates.id, schema.activityVersions.templateId),
      eq(schema.activityTemplates.venueId, schema.activityVersions.venueId),
    ))
    .where(and(
      eq(schema.publications.venueId, venueId),
      eq(schema.publications.status, "active"),
      eq(schema.venues.status, "active"),
      lte(schema.publications.activatedAt, now),
      isNull(schema.publications.deactivatedAt),
    ))
    .limit(1);

  if (!row || row.templateStatus === "archived" || !isValidActivityContent(row.content)) fail("ACTIVITY_UNAVAILABLE");
  return { ...row, cues: row.content.cues };
}

export function isValidActivityContent(value: unknown): value is schema.ActivityContent {
  if (!value || typeof value !== "object" || !Array.isArray((value as schema.ActivityContent).cues)) return false;
  const cues = (value as schema.ActivityContent).cues;
  if (cues.length !== 3) return false;
  const keys = new Set<string>();
  return cues.every((cue) => {
    if (!cue || typeof cue.key !== "string" || !cue.key.trim() || keys.has(cue.key)
      || typeof cue.prompt !== "string" || !cue.prompt.trim() || !Array.isArray(cue.choices)
      || cue.choices.length !== 3 || cue.choices.some((choice) => typeof choice !== "string" || !choice.trim())) return false;
    keys.add(cue.key);
    return true;
  });
}
