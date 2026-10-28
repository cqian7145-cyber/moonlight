import type { BetterAuthPlugin } from "better-auth";

/** Temporary, opt-in diagnostics. Never inspect the body, cookies, or full context. */
export const merchantOriginDiagnostics = {
  id: "moonlight-origin-diagnostics",
  onRequest: async (request, context) => {
    if (process.env.MOONLIGHT_AUTH_ORIGIN_DIAGNOSTICS !== "1") return;
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/auth/sign-in/email") return;

    try {
      // JSON encoding keeps untrusted header values on one structured log line.
      console.info("[moonlight-auth-origin-diagnostic]", JSON.stringify({
        Origin: request.headers.get("origin"),
        trustedOrigins: context.trustedOrigins,
        baseURL: context.baseURL,
        Host: request.headers.get("host"),
        "X-Forwarded-Host": request.headers.get("x-forwarded-host"),
        "X-Forwarded-Proto": request.headers.get("x-forwarded-proto"),
      }));
    } catch {
      // Diagnostics must never change authentication behavior or log raw errors.
    }
  },
} satisfies BetterAuthPlugin;
