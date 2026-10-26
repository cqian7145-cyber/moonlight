import { getMerchantAuth } from "@/lib/merchant-auth";
import { getDb } from "@/db";
import { createMerchantHandlers, merchantJson } from "@/server/merchant-api";

export async function GET(request: Request, context: { params: Promise<{ venueId: string }> }) {
  const auth = getMerchantAuth();
  if (!auth) return merchantJson(503, { error: "merchant_auth_unavailable" });
  try {
    const { venueId } = await context.params;
    return await createMerchantHandlers(getDb(), auth).venue(request, venueId);
  } catch {
    return merchantJson(503, { error: "merchant_service_unavailable" });
  }
}
