import "server-only";
import type { MerchantAuthDb } from "../lib/merchant-auth";
import type { createMerchantAuth } from "../lib/merchant-auth";
import { listVenueMemberships, requireVenueMember, requireVenueOwner } from "./venue-auth";

type MerchantAuth = ReturnType<typeof createMerchantAuth>;

export function merchantJson(status: number, body: Record<string, unknown>) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      Vary: "Cookie",
    },
  });
}

export function createMerchantHandlers(db: MerchantAuthDb, auth: MerchantAuth) {
  return {
    async venues(request: Request) {
      if (request.method !== "GET") return merchantJson(405, { error: "method_not_allowed" });
      try {
        const result = await listVenueMemberships(db, auth, request.headers);
        if (result.kind === "unauthenticated") return merchantJson(401, { error: "authentication_required" });
        return merchantJson(200, { venues: result.venues.map(({ id, name, status, role }) => ({ id, name, status, role })) });
      } catch {
        return merchantJson(503, { error: "merchant_service_unavailable" });
      }
    },

    async venue(request: Request, venueId: string, ownerOnly = false) {
      if (request.method !== "GET") return merchantJson(405, { error: "method_not_allowed" });
      try {
        const result = ownerOnly
          ? await requireVenueOwner(db, auth, request.headers, venueId)
          : await requireVenueMember(db, auth, request.headers, venueId);
        if (result.kind === "unauthenticated") return merchantJson(401, { error: "authentication_required" });
        if (result.kind === "forbidden") return merchantJson(403, { error: "venue_access_denied" });
        return merchantJson(200, { venue: result.venue });
      } catch {
        return merchantJson(503, { error: "merchant_service_unavailable" });
      }
    },
  };
}
