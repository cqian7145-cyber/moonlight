import "server-only";
import type { createMerchantAuth } from "../lib/merchant-auth";
import type { DomainDb } from "./db-scoped";
import { requireVenueMember } from "./venue-auth";
import { getVenueAnalytics } from "./venue-analytics";

type Auth = ReturnType<typeof createMerchantAuth>;
function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive", Vary: "Cookie" } });
}

export function createAnalyticsApiHandlers(db: DomainDb, auth: Auth) {
  return {
    async get(request: Request, venueId: string) {
      const period = new URL(request.url).searchParams.getAll("period");
      if (period.length > 1 || (period.length === 1 && period[0] !== "7d" && period[0] !== "30d")) return json(400, { error: "invalid_request" });
      try {
        const access = await requireVenueMember(db as never, auth, request.headers, venueId);
        if (access.kind === "unauthenticated") return json(401, { error: "authentication_required" });
        if (access.kind !== "allowed") return json(403, { error: "venue_access_denied" });
        const days = period[0] === "30d" ? 30 : 7;
        const analytics = await getVenueAnalytics(db, venueId, { days });
        return json(200, { venue: { name: access.venue.name, role: access.venue.role }, analytics });
      } catch { return json(503, { error: "analytics_unavailable" }); }
    },
  };
}
