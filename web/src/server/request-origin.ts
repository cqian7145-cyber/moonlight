import "server-only";

function configuredOrigin(explicit: string | undefined, request: Request): string | null {
  const value = explicit ?? process.env.MOONLIGHT_PUBLIC_ORIGIN ?? process.env.BETTER_AUTH_URL;
  if (value) {
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.origin !== value || (url.protocol !== "https:" && !local)) return null;
      return url.origin;
    } catch { return null; }
  }
  // Unit and integration tests use explicit synthetic request URLs. Runtime requests fail closed.
  if (process.env.NODE_ENV === "test") {
    try { return new URL(request.url).origin; } catch { return null; }
  }
  return null;
}

export function isTrustedSameOrigin(request: Request, explicitTrustedOrigin?: string): boolean {
  const expected = configuredOrigin(explicitTrustedOrigin, request);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!expected || !origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    const expectedUrl = new URL(expected);
    if (originUrl.origin !== origin || originUrl.origin !== expectedUrl.origin) return false;
    if (host.toLowerCase() !== expectedUrl.host.toLowerCase()) return false;
    if (new URL(request.url).protocol !== expectedUrl.protocol) return false;
  } catch { return false; }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}
