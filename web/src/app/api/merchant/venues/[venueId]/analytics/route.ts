import { getDb } from "@/db";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { createAnalyticsApiHandlers } from "@/server/analytics-api";

export async function GET(request: Request, context: { params: Promise<{ venueId: string }> }) {
  const auth = getMerchantAuth();
  if (!auth) return Response.json({ error: "analytics_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  try { const { venueId } = await context.params; return await createAnalyticsApiHandlers(getDb() as never, auth).get(request, venueId); }
  catch { return Response.json({ error: "analytics_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
}
