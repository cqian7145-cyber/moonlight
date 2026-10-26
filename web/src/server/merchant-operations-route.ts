import "server-only";
import { getDb } from "../db";
import { getMerchantAuth } from "../lib/merchant-auth";
import { merchantJson } from "./merchant-api";
import { createMerchantOperationsHandlers } from "./merchant-operations";

export async function withMerchantOperations(request: Request, run: (handlers: ReturnType<typeof createMerchantOperationsHandlers>) => Promise<Response>) {
  try {
    const auth = getMerchantAuth();
    const publicOrigin = process.env.MOONLIGHT_PUBLIC_ORIGIN ?? process.env.BETTER_AUTH_URL;
    if (!auth || !publicOrigin) return merchantJson(503, { error: "merchant_service_unavailable" });
    return await run(createMerchantOperationsHandlers(getDb(), auth, { publicOrigin }));
  } catch {
    return merchantJson(503, { error: "merchant_service_unavailable" });
  }
}
