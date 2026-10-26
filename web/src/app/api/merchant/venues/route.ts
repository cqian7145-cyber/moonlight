import { getMerchantAuth } from "@/lib/merchant-auth";
import { getDb } from "@/db";
import { createMerchantHandlers, merchantJson } from "@/server/merchant-api";

export async function GET(request: Request) {
  const auth = getMerchantAuth();
  if (!auth) return merchantJson(503, { error: "merchant_auth_unavailable" });
  try {
    return await createMerchantHandlers(getDb(), auth).venues(request);
  } catch {
    return merchantJson(503, { error: "merchant_service_unavailable" });
  }
}
