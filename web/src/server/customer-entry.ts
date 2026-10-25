import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { DomainDb, findAvailablePublication } from "./db-scoped";
import { DomainError } from "./errors";
import { hashToken, ServiceDependencies, serviceNow } from "./tokens";

export type PublicTableEntry =
  | { status: "ready"; venueName: string; activityTitle: string; questionCount: number }
  | { status: "not_found" }
  | { status: "table_paused" }
  | { status: "venue_paused" }
  | { status: "no_activity" }
  | { status: "unavailable" };

const TABLE_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type CustomerTableContext =
  | { status: "ready"; venueId: string; venueName: string }
  | { status: "not_found" }
  | { status: "table_paused" }
  | { status: "venue_paused" };

export function isValidPublicTableCode(value: string): boolean {
  return TABLE_CODE_PATTERN.test(value);
}

export async function getCustomerTableContext(db: DomainDb, tableCode: string): Promise<CustomerTableContext> {
  if (!isValidPublicTableCode(tableCode)) return { status: "not_found" };
  const [table] = await db.select({
    venueId: schema.venueTables.venueId,
    tableEnabled: schema.venueTables.isEnabled,
    venueName: schema.venues.name,
    venueStatus: schema.venues.status,
  }).from(schema.venueTables)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.venueTables.venueId))
    .where(eq(schema.venueTables.publicCodeHash, hashToken(tableCode)))
    .limit(1);

  if (!table) return { status: "not_found" };
  if (!table.tableEnabled) return { status: "table_paused" };
  if (table.venueStatus !== "active") return { status: "venue_paused" };
  return { status: "ready", venueId: table.venueId, venueName: table.venueName };
}

export async function getPublicTableEntry(
  db: DomainDb,
  tableCode: string,
  dependencies?: Pick<ServiceDependencies, "clock">,
): Promise<PublicTableEntry> {
  const table = await getCustomerTableContext(db, tableCode);
  if (table.status !== "ready") return { status: table.status };

  try {
    const activity = await findAvailablePublication(db, table.venueId, serviceNow(dependencies));
    return {
      status: "ready",
      venueName: table.venueName,
      activityTitle: activity.title,
      questionCount: activity.cues.length,
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === "ACTIVITY_UNAVAILABLE") return { status: "no_activity" };
    throw error;
  }
}

export async function loadCustomerEntryPage(
  tableCode: string,
  databaseProvider: () => DomainDb = getDb,
  dependencies?: Pick<ServiceDependencies, "clock">,
): Promise<PublicTableEntry> {
  if (!isValidPublicTableCode(tableCode)) return { status: "not_found" };
  try {
    return await getPublicTableEntry(databaseProvider(), tableCode, dependencies);
  } catch {
    // Never return raw adapter errors, connection details, or request codes to the page.
    return { status: "unavailable" };
  }
}
