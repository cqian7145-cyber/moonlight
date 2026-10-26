import "server-only";
import { and, eq } from "drizzle-orm";
import type { MerchantAuthDb } from "../lib/merchant-auth";
import type { createMerchantAuth } from "../lib/merchant-auth";
import * as schema from "../db/schema";

type MerchantAuth = ReturnType<typeof createMerchantAuth>;

export type VenueAccess =
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | {
      kind: "allowed";
      user: { id: string; name: string; email: string };
      venue: { id: string; name: string; status: "active" | "suspended" | "archived"; role: "owner" | "staff" };
    };

export type VenueSummary = { id: string; name: string; status: "active" | "suspended" | "archived"; role: "owner" | "staff" };

export type VenueListAccess =
  | { kind: "unauthenticated" }
  | { kind: "allowed"; user: { id: string; name: string; email: string }; venues: VenueSummary[] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function getEnabledIdentity(db: MerchantAuthDb, auth: MerchantAuth, requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const [user] = await db.select({ id: schema.authUsers.id, disabled: schema.authUsers.disabled })
    .from(schema.authUsers).where(eq(schema.authUsers.id, session.user.id)).limit(1);
  if (!user || user.disabled) return null;
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function listVenueMemberships(
  db: MerchantAuthDb,
  auth: MerchantAuth,
  requestHeaders: Headers,
): Promise<VenueListAccess> {
  const user = await getEnabledIdentity(db, auth, requestHeaders);
  if (!user) return { kind: "unauthenticated" };
  const venues = await db.select({
    id: schema.venues.id,
    name: schema.venues.name,
    status: schema.venues.status,
    role: schema.venueMembers.role,
  }).from(schema.venueMembers)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.venueMembers.venueId))
    .where(and(eq(schema.venueMembers.userId, user.id), eq(schema.venueMembers.status, "active")))
    .orderBy(schema.venues.name, schema.venues.id);
  return { kind: "allowed", user, venues };
}

async function requireRole(
  db: MerchantAuthDb,
  auth: MerchantAuth,
  requestHeaders: Headers,
  venueId: string,
  minimum: "staff" | "owner",
): Promise<VenueAccess> {
  const user = await getEnabledIdentity(db, auth, requestHeaders);
  if (!user) return { kind: "unauthenticated" };
  if (!UUID_PATTERN.test(venueId)) return { kind: "forbidden" };

  const [membership] = await db.select({
    id: schema.venues.id,
    name: schema.venues.name,
    status: schema.venues.status,
    role: schema.venueMembers.role,
  }).from(schema.venueMembers)
    .innerJoin(schema.venues, eq(schema.venues.id, schema.venueMembers.venueId))
    .where(and(
      eq(schema.venueMembers.venueId, venueId),
      eq(schema.venueMembers.userId, user.id),
      eq(schema.venueMembers.status, "active"),
    )).limit(1);

  if (!membership || (minimum === "owner" && membership.role !== "owner")) return { kind: "forbidden" };
  return { kind: "allowed", user, venue: membership };
}

export function requireVenueMember(db: MerchantAuthDb, auth: MerchantAuth, headers: Headers, venueId: string) {
  return requireRole(db, auth, headers, venueId, "staff");
}

export function requireVenueOwner(db: MerchantAuthDb, auth: MerchantAuth, headers: Headers, venueId: string) {
  return requireRole(db, auth, headers, venueId, "owner");
}
