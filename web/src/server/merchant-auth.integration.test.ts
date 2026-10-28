import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth";
import { createMerchantHandlers } from "./merchant-api";
import { listVenueMemberships, requireVenueMember, requireVenueOwner } from "./venue-auth";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const baseURL = "http://localhost:3000";
const secret = "test-secret-with-at-least-thirty-two-characters";

function authRequest(path: string, body: unknown, cookie?: string, origin = baseURL) {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${baseURL}/api/auth/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function provision(auth: ReturnType<typeof createMerchantAuth>, email: string, password: string) {
  return auth.api.signUpEmail({ body: { name: "虚构验收账号", email, password } });
}

async function login(auth: ReturnType<typeof createMerchantAuth>, email: string, password: string) {
  const response = await auth.handler(authRequest("sign-in/email", { email, password }));
  if (response.status !== 200) throw new Error("Synthetic merchant login failed.");
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function createVenue(name: string) {
  const [venue] = await db.insert(schema.venues).values({ name }).returning();
  return venue!;
}

async function addMember(venueId: string, userId: string, role: "owner" | "staff") {
  await db.insert(schema.venueMembers).values({ venueId, userId, role });
}

describe("merchant authentication backed by the checked-in migration", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await client.close();
  });

  it("logs only the live origin context when opted in and preserves INVALID_ORIGIN rejection", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const auth = createMerchantAuth(db as never, { baseURL, secret, loggerDisabled: true });
    const makeRequest = () => new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: "https://untrusted.example.test",
        host: "private-web:3000",
        "x-forwarded-host": "moonlight.xizimist.com",
        "x-forwarded-proto": "https",
        cookie: "private-cookie-marker",
        authorization: "Bearer private-token-marker",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "private-email@example.test", password: "private-password-marker" }),
    });

    vi.stubEnv("MOONLIGHT_AUTH_ORIGIN_DIAGNOSTICS", "0");
    expect((await auth.handler(makeRequest())).status).toBe(403);
    expect(info).not.toHaveBeenCalled();
    vi.stubEnv("MOONLIGHT_AUTH_ORIGIN_DIAGNOSTICS", "1");
    const response = await auth.handler(makeRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INVALID_ORIGIN" });
    expect(info).toHaveBeenCalledTimes(1);
    const [prefix, json] = info.mock.calls[0]!;
    expect(prefix).toBe("[moonlight-auth-origin-diagnostic]");
    const context = await auth.$context;
    expect(JSON.parse(json as string)).toEqual({
      Origin: "https://untrusted.example.test",
      trustedOrigins: context.trustedOrigins,
      baseURL: context.baseURL,
      Host: "private-web:3000",
      "X-Forwarded-Host": "moonlight.xizimist.com",
      "X-Forwarded-Proto": "https",
    });
    expect(String(json)).not.toMatch(/private-(?:cookie|token|email|password)/);
    expect(String(json)).not.toContain(secret);
    info.mockClear();
    await auth.handler(new Request(`${baseURL}/api/auth/get-session`));
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects raw public sign-up requests", async () => {
    const auth = createMerchantAuth(db as never, {
      baseURL: "http://localhost:3000",
      secret: "test-secret-with-at-least-thirty-two-characters",
    });
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Public signup", email: "public@example.test", password: "not-a-real-password" }),
    }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.authUsers)).toHaveLength(0);
  });

  it("creates an HttpOnly session on login and revokes it on server-side logout", async () => {
    const publicAuth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const email = `owner-${crypto.randomUUID()}@example.test`;
    const password = `Valid-${crypto.randomUUID()}-A9!`;
    const created = await provision(provisionAuth, email, password);
    const [account] = await db.select({ password: schema.authAccounts.password }).from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, created.user.id)).limit(1);
    expect(account?.password).not.toBe(password);

    const signIn = await publicAuth.handler(authRequest("sign-in/email", { email, password }));
    expect(signIn.status).toBe(200);
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain("moonlight_merchant");
    const cookie = setCookie.split(";")[0]!;

    expect(await publicAuth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    const logout = await publicAuth.handler(authRequest("sign-out", {}, cookie));
    expect(logout.status).toBe(200);
    expect(await publicAuth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it("uses the same public login error for an unknown email and a wrong password", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const email = `known-${crypto.randomUUID()}@example.test`;
    await provision(provisionAuth, email, `Valid-${crypto.randomUUID()}-A9!`);

    const [wrong, unknown] = await Promise.all([
      auth.handler(authRequest("sign-in/email", { email, password: "Wrong-password-000!" })),
      auth.handler(authRequest("sign-in/email", { email: `unknown-${crypto.randomUUID()}@example.test`, password: "Wrong-password-000!" })),
    ]);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("rejects login for a disabled account even with its valid password", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const email = `disabled-${crypto.randomUUID()}@example.test`;
    const password = `Valid-${crypto.randomUUID()}-A9!`;
    const created = await provision(provisionAuth, email, password);
    await db.update(schema.authUsers).set({ disabled: true }).where(eq(schema.authUsers.id, created.user.id));

    const response = await auth.handler(authRequest("sign-in/email", { email, password }));
    expect(response.status).toBe(401);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: response.headers.get("set-cookie") ?? "" }) })).toBeNull();
  });

  it("rejects cross-origin authentication writes and rate limits repeated login failures", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const crossOrigin = await auth.handler(authRequest("sign-in/email", {
      email: `nobody-${crypto.randomUUID()}@example.test`, password: "Wrong-password-000!",
    }, undefined, "https://attacker.example"));
    expect(crossOrigin.status).toBe(403);

    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await auth.handler(authRequest("sign-in/email", {
        email: `nobody-${crypto.randomUUID()}@example.test`, password: "Wrong-password-000!",
      })));
    }
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it("enforces owner, staff, and no-membership access within explicit venue scopes", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const venueA = await createVenue("虚构门店甲");
    const venueB = await createVenue("虚构门店乙");
    const ownerEmail = `owner-${crypto.randomUUID()}@example.test`;
    const ownerPassword = `Valid-${crypto.randomUUID()}-A9!`;
    const owner = await provision(provisionAuth, ownerEmail, ownerPassword);
    await addMember(venueA.id, owner.user.id, "owner");
    const ownerCookie = await login(auth, ownerEmail, ownerPassword);

    expect(await requireVenueMember(db as never, auth, new Headers({ cookie: ownerCookie }), venueA.id)).toMatchObject({
      kind: "allowed", venue: { id: venueA.id, role: "owner", name: "虚构门店甲" },
    });
    expect(await requireVenueOwner(db as never, auth, new Headers({ cookie: ownerCookie }), venueA.id)).toMatchObject({ kind: "allowed" });
    expect(await requireVenueMember(db as never, auth, new Headers({ cookie: ownerCookie }), venueB.id)).toEqual({ kind: "forbidden" });
    expect(await listVenueMemberships(db as never, auth, new Headers({ cookie: ownerCookie }))).toMatchObject({
      kind: "allowed", venues: [{ id: venueA.id, name: "虚构门店甲", role: "owner" }],
    });

    const staffEmail = `staff-${crypto.randomUUID()}@example.test`;
    const staffPassword = `Valid-${crypto.randomUUID()}-B8!`;
    const staff = await provision(provisionAuth, staffEmail, staffPassword);
    await addMember(venueA.id, staff.user.id, "staff");
    const staffCookie = await login(auth, staffEmail, staffPassword);
    expect(await requireVenueMember(db as never, auth, new Headers({ cookie: staffCookie }), venueA.id)).toMatchObject({ kind: "allowed", venue: { role: "staff" } });
    expect(await requireVenueOwner(db as never, auth, new Headers({ cookie: staffCookie }), venueA.id)).toEqual({ kind: "forbidden" });

    const outsiderEmail = `outsider-${crypto.randomUUID()}@example.test`;
    const outsiderPassword = `Valid-${crypto.randomUUID()}-C7!`;
    await provision(provisionAuth, outsiderEmail, outsiderPassword);
    const outsiderCookie = await login(auth, outsiderEmail, outsiderPassword);
    expect(await requireVenueMember(db as never, auth, new Headers({ cookie: outsiderCookie }), venueA.id)).toEqual({ kind: "forbidden" });
  });

  it("revokes venue access on the next request after membership or account disablement", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const venue = await createVenue("虚构门店撤权验收");
    const email = `revoked-${crypto.randomUUID()}@example.test`;
    const password = `Valid-${crypto.randomUUID()}-D6!`;
    const created = await provision(provisionAuth, email, password);
    await addMember(venue.id, created.user.id, "owner");
    const cookie = await login(auth, email, password);
    const headers = new Headers({ cookie });

    expect(await requireVenueOwner(db as never, auth, headers, venue.id)).toMatchObject({ kind: "allowed" });
    await db.update(schema.venueMembers).set({ status: "disabled" })
      .where(eq(schema.venueMembers.userId, created.user.id));
    expect(await requireVenueOwner(db as never, auth, headers, venue.id)).toEqual({ kind: "forbidden" });

    await db.update(schema.venueMembers).set({ status: "active" })
      .where(eq(schema.venueMembers.userId, created.user.id));
    await db.update(schema.authUsers).set({ disabled: true }).where(eq(schema.authUsers.id, created.user.id));
    expect(await requireVenueOwner(db as never, auth, headers, venue.id)).toEqual({ kind: "unauthenticated" });
  });

  it("projects only authorized venue data through private GET handlers", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const venueA = await createVenue("虚构门店 API A");
    const venueB = await createVenue("虚构门店 API B");
    const email = `api-${crypto.randomUUID()}@example.test`;
    const password = `Valid-${crypto.randomUUID()}-E9!`;
    const created = await provision(provisionAuth, email, password);
    await addMember(venueA.id, created.user.id, "staff");
    const cookie = await login(auth, email, password);
    const handlers = createMerchantHandlers(db as never, auth);
    const headers = new Headers({ cookie });

    const ownList = await handlers.venues(new Request(`${baseURL}/api/merchant/venues`, { headers }));
    expect(ownList.status).toBe(200);
    expect(await ownList.json()).toMatchObject({ venues: [{ id: venueA.id, name: venueA.name, role: "staff" }] });
    expect(ownList.headers.get("cache-control")).toContain("no-store");
    expect(ownList.headers.get("vary")).toBe("Cookie");

    const ownVenue = await handlers.venue(new Request(`${baseURL}/api/merchant/venues/${venueA.id}`, { headers }), venueA.id);
    expect(ownVenue.status).toBe(200);
    expect(await ownVenue.json()).toMatchObject({ venue: { id: venueA.id, name: venueA.name, role: "staff" } });

    const otherVenue = await handlers.venue(new Request(`${baseURL}/api/merchant/venues/${venueB.id}`, { headers }), venueB.id);
    expect(otherVenue.status).toBe(403);
    expect(await otherVenue.json()).toEqual({ error: "venue_access_denied" });

    const ownerOnly = await handlers.venue(new Request(`${baseURL}/api/merchant/venues/${venueA.id}/admin`, { headers }), venueA.id, true);
    expect(ownerOnly.status).toBe(403);
    expect(await ownerOnly.json()).toEqual({ error: "venue_access_denied" });

    const noSession = await handlers.venues(new Request(`${baseURL}/api/merchant/venues`));
    expect(noSession.status).toBe(401);
  });

  it("fails closed with a generic 503 when the authorization database is unavailable", async () => {
    const auth = createMerchantAuth(db as never, { baseURL, secret });
    const provisionAuth = createMerchantAuth(db as never, { baseURL, secret, allowProvisioning: true });
    const venue = await createVenue("虚构门店数据库故障");
    const email = `database-${crypto.randomUUID()}@example.test`;
    const password = `Valid-${crypto.randomUUID()}-F3!`;
    const created = await provision(provisionAuth, email, password);
    await addMember(venue.id, created.user.id, "owner");
    const cookie = await login(auth, email, password);
    const unavailableDb = new Proxy(db as object, {
      get(target, property, receiver) {
        if (property === "select") return () => { throw new Error("private database connection details"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const handlers = createMerchantHandlers(unavailableDb as never, auth);
    const response = await handlers.venues(new Request(`${baseURL}/api/merchant/venues`, { headers: { cookie } }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe(JSON.stringify({ error: "merchant_service_unavailable" }));
    expect(body).not.toContain("private database connection details");
  });
});
