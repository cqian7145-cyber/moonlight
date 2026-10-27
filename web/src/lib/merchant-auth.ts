import "server-only";
import { createMerchantAuth } from "./merchant-auth-core";
import { getDb } from "../db";

export { createMerchantAuth } from "./merchant-auth-core";
export type { MerchantAuthDb } from "./merchant-auth-core";

let productionAuth: ReturnType<typeof createMerchantAuth> | undefined;

export function getMerchantAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32 || !baseURL) return null;
  try {
    productionAuth ??= createMerchantAuth(getDb(), { secret, baseURL });
    return productionAuth;
  } catch {
    return null;
  }
}
