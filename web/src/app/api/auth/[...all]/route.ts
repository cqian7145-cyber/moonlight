import { getMerchantAuth } from "@/lib/merchant-auth";
import { merchantJson } from "@/server/merchant-api";

async function handle(request: Request) {
  const auth = getMerchantAuth();
  if (!auth) return merchantJson(503, { error: "merchant_auth_unavailable" });
  try {
    const response = await auth.handler(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("Vary", "Cookie");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return merchantJson(503, { error: "merchant_auth_unavailable" });
  }
}

export const GET = handle;
export const POST = handle;
