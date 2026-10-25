import "server-only";
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { DomainDb, findAvailablePublication } from "./db-scoped";
import { fail } from "./errors";
import { hashToken, ServiceDependencies, serviceNow } from "./tokens";

export type ActivityLocator = { venueId: string; publicTableCode?: string };

export async function getCurrentActivity(db: DomainDb, locator: ActivityLocator, dependencies?: Pick<ServiceDependencies, "clock">) {
  const activity = await findAvailablePublication(db, locator.venueId, serviceNow(dependencies));
  let tableId: string | null = null;
  if (locator.publicTableCode !== undefined) {
    const codeHash = hashToken(locator.publicTableCode);
    const [table] = await db.select({ id: schema.venueTables.id })
      .from(schema.venueTables)
      .where(and(
        eq(schema.venueTables.venueId, locator.venueId),
        eq(schema.venueTables.publicCodeHash, codeHash),
        eq(schema.venueTables.isEnabled, true),
      )).limit(1);
    if (!table) fail("ACTIVITY_UNAVAILABLE");
    tableId = table.id;
  }

  return {
    venueId: activity.venueId,
    publicationId: activity.publicationId,
    versionId: activity.versionId,
    title: activity.title,
    tableId,
    cues: activity.cues,
  };
}
