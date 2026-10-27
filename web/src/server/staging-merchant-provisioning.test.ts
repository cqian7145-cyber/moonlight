import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth-core";
import { requireVenueOwner } from "./venue-auth";
import {
  assertStagingDatabaseIdentity,
  formatProvisionResult,
  inspectProvisionTarget,
  provisionStagingMerchant,
  validateProvisionDatabaseTarget,
  validateProvisionInput,
  validateStagingProvisionEnvironment,
  tryAcquireProvisionLock,
} from "./staging-merchant-provisioning";

const VENUE_ID = "961b6054-e798-4c19-9bbf-a11050c55047";
const VENUE_NAME = "Moonlight Staging 测试酒馆";
const BASE_URL = "https://provisioning.moonlight.invalid";
const AUTH_SECRET = "test-only-secret-with-more-than-thirty-two-characters";
const GOOD_PASSWORD = "Test-Only-Password-493!";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

function createAuth(allowProvisioning = true) {
  return createMerchantAuth(db as never, {
    baseURL: BASE_URL,
    secret: AUTH_SECRET,
    allowProvisioning,
    adapterTransaction: true,
    loggerDisabled: true,
  });
}

async function createVenue(status: "active" | "suspended" = "active") {
  const [venue] = await db.insert(schema.venues).values({ id: VENUE_ID, name: VENUE_NAME, status }).returning();
  return venue!;
}

function request(email: string, overrides: Partial<Parameters<typeof provisionStagingMerchant>[0]> = {}) {
  return {
    db: db as never,
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    name: "Staging Merchant",
    email,
    password: GOOD_PASSWORD,
    confirmation: GOOD_PASSWORD,
    execute: false,
    createAccount: async ({ name, email: accountEmail, password }: { name: string; email: string; password: string }) =>
      createAuth().api.signUpEmail({ body: { name, email: accountEmail, password } }),
    ...overrides,
  };
}

describe("M-015A staging merchant provisioning guards", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    await createVenue();
  });

  afterEach(async () => {
    await client.close();
  });

  it("requires explicit write gates and never accepts app or migration URLs", () => {
    const base = { NODE_ENV: "production", PROVISION_DATABASE_URL: "configured-out-of-band" };
    expect(validateStagingProvisionEnvironment(base, [])).toEqual({ execute: false });
    expect(() => validateStagingProvisionEnvironment({ ...base, DATABASE_URL: "present" }, [])).toThrow(/DATABASE_URL/);
    expect(() => validateStagingProvisionEnvironment({ ...base, MIGRATION_DATABASE_URL: "present" }, [])).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() => validateStagingProvisionEnvironment({ NODE_ENV: "production" }, [])).toThrow(/PROVISION_DATABASE_URL/);
    expect(() => validateStagingProvisionEnvironment({ ...base, MOONLIGHT_STAGING_PROVISION: "1" }, ["--execute"]))
      .toThrowError(expect.objectContaining({ code: "execute_confirmation_required" }));
    expect(validateStagingProvisionEnvironment({
      ...base,
      MOONLIGHT_STAGING_PROVISION: "1",
      MOONLIGHT_STAGING_PROVISION_CONFIRM: "CREATE_STAGING_MERCHANT_OWNER",
    }, ["--execute"]))
      .toEqual({ execute: true });
    expect(() => validateStagingProvisionEnvironment({ ...base, NODE_ENV: "development" }, []))
      .toThrow(/production/);
  });

  it("accepts only the exact private Staging endpoint and application role/database", () => {
    const target = validateProvisionDatabaseTarget(
      "postgresql://moonlight_app:synthetic@postgres.railway.internal:5432/railway",
    );
    expect(target).toMatchObject({ host: "postgres.railway.internal", database: "railway", username: "moonlight_app" });
    expect(() => validateProvisionDatabaseTarget("postgresql://moonlight_app:x@public-proxy.railway.app:5432/railway"))
      .toThrowError(expect.objectContaining({ code: "database_host_not_approved" }));
    expect(() => validateProvisionDatabaseTarget("postgresql://moonlight_migrator:x@postgres.railway.internal:5432/railway"))
      .toThrowError(expect.objectContaining({ code: "database_role_not_approved" }));
    expect(() => validateProvisionDatabaseTarget("postgresql://moonlight_app:x@postgres.railway.internal:5432/moonlight_dev"))
      .toThrowError(expect.objectContaining({ code: "database_name_not_approved" }));
    expect(() => validateProvisionDatabaseTarget("postgresql://moonlight_app@postgres.railway.internal:5432/railway"))
      .toThrowError(expect.objectContaining({ code: "database_role_not_approved" }));

    const leastPrivilegeIdentity = {
      database: "railway",
      currentUser: "moonlight_app",
      sessionUser: "moonlight_app",
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    };
    expect(() => assertStagingDatabaseIdentity(leastPrivilegeIdentity)).not.toThrow();
    expect(() => assertStagingDatabaseIdentity({ ...leastPrivilegeIdentity, currentUser: "postgres", sessionUser: "postgres" }))
      .toThrowError(expect.objectContaining({ code: "database_role_not_approved" }));
    expect(() => assertStagingDatabaseIdentity({ ...leastPrivilegeIdentity, database: "moonlight_dev" }))
      .toThrowError(expect.objectContaining({ code: "database_name_not_approved" }));
    expect(() => assertStagingDatabaseIdentity({ ...leastPrivilegeIdentity, createRole: true }))
      .toThrowError(expect.objectContaining({ code: "database_privileges_not_approved" }));
  });

  it("validates the fixed venue, email, name, password and confirmation", () => {
    expect(validateProvisionInput({
      venueId: VENUE_ID, name: "  Owner  ", email: "Owner@example.test", password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD,
    })).toEqual({ venueId: VENUE_ID, name: "Owner", email: "owner@example.test", password: GOOD_PASSWORD });
    expect(() => validateProvisionInput({ venueId: "00000000-0000-4000-8000-000000000000", name: "Owner", email: "owner@example.test", password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD })).toThrowError(expect.objectContaining({ code: "venue_id_not_approved" }));
    expect(() => validateProvisionInput({ venueId: VENUE_ID, name: "Owner", email: "not-an-email", password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD })).toThrowError(expect.objectContaining({ code: "input_invalid" }));
    expect(() => validateProvisionInput({ venueId: VENUE_ID, name: "Owner", email: "owner@example.test", password: "weak", confirmation: "weak" })).toThrowError(expect.objectContaining({ code: "input_invalid" }));
    expect(() => validateProvisionInput({ venueId: VENUE_ID, name: "Owner", email: "owner@example.test", password: GOOD_PASSWORD, confirmation: "different" })).toThrowError(expect.objectContaining({ code: "input_invalid" }));
  });

  it("dry-run checks venue and account state without writing", async () => {
    const result = await provisionStagingMerchant(request("new-owner@example.test"));
    expect(result).toMatchObject({ kind: "dry-run", venueId: VENUE_ID, venueName: VENUE_NAME });
    expect(await db.select().from(schema.authUsers)).toHaveLength(0);
    expect(await db.select().from(schema.authAccounts)).toHaveLength(0);
    expect(await db.select().from(schema.venueMembers)).toHaveLength(0);
  });

  it("uses Better Auth to create a credential, links owner access, and permits configured login", async () => {
    const email = "new-owner@example.test";
    const result = await provisionStagingMerchant(request(email, { execute: true }));
    expect(result).toMatchObject({ kind: "created", venueId: VENUE_ID, role: "owner" });
    const [user] = await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, email));
    const [account] = await db.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, user!.id));
    const [member] = await db.select().from(schema.venueMembers).where(eq(schema.venueMembers.userId, user!.id));
    expect(account?.providerId).toBe("credential");
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toBe(GOOD_PASSWORD);
    expect(member).toMatchObject({ venueId: VENUE_ID, userId: user!.id, role: "owner", status: "active" });

    const auth = createAuth(false);
    const login = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: GOOD_PASSWORD }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(await requireVenueOwner(db as never, auth, new Headers({ cookie }), VENUE_ID)).toMatchObject({
      kind: "allowed",
      venue: { id: VENUE_ID, role: "owner", name: VENUE_NAME },
    });
    const publicSignup = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ name: "Public", email: "public@example.test", password: GOOD_PASSWORD }),
    }));
    expect(publicSignup.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, "public@example.test"))).toHaveLength(0);
  });

  it("rolls back Better Auth user creation if credential-account insertion fails", async () => {
    await client.exec("ALTER TABLE auth_accounts ADD CONSTRAINT test_reject_credential CHECK (provider_id <> 'credential')");
    const auth = createAuth();
    await expect(auth.api.signUpEmail({ body: {
      name: "Atomicity Test",
      email: "atomic-failure@example.test",
      password: GOOD_PASSWORD,
    } })).rejects.toBeTruthy();
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, "atomic-failure@example.test"))).toHaveLength(0);
    expect(await db.select().from(schema.authAccounts)).toHaveLength(0);
  });

  it("refuses duplicate execution and never promotes an existing email", async () => {
    const email = "existing@example.test";
    await provisionStagingMerchant(request(email, { execute: true }));
    const counts = {
      users: (await db.select().from(schema.authUsers)).length,
      accounts: (await db.select().from(schema.authAccounts)).length,
      members: (await db.select().from(schema.venueMembers)).length,
    };
    await expect(provisionStagingMerchant(request(email, { execute: true }))).rejects.toMatchObject({ code: "already_member" });
    expect(await db.select().from(schema.authUsers)).toHaveLength(counts.users);
    expect(await db.select().from(schema.authAccounts)).toHaveLength(counts.accounts);
    expect(await db.select().from(schema.venueMembers)).toHaveLength(counts.members);

    const foreignVenue = await db.insert(schema.venues).values({ name: "Another synthetic venue" }).returning();
    const otherEmail = "member-elsewhere@example.test";
    const created = await createAuth().api.signUpEmail({ body: { name: "Existing", email: otherEmail, password: GOOD_PASSWORD } });
    await db.insert(schema.venueMembers).values({ venueId: foreignVenue[0]!.id, userId: created.user.id, role: "staff" });
    await expect(provisionStagingMerchant(request(otherEmail, { execute: true }))).rejects.toMatchObject({ code: "existing_user_other_venue" });
    expect(await db.select().from(schema.venueMembers).where(eq(schema.venueMembers.userId, created.user.id))).toMatchObject([
      { venueId: foreignVenue[0]!.id, role: "staff" },
    ]);
  });

  it("rejects missing, inactive or already-owned venues and existing accounts without membership", async () => {
    await db.update(schema.venues).set({ status: "suspended" }).where(eq(schema.venues.id, VENUE_ID));
    await expect(inspectProvisionTarget(db as never, VENUE_ID, "a@example.test")).rejects.toMatchObject({ code: "venue_inactive" });
    await db.update(schema.venues).set({ status: "active" }).where(eq(schema.venues.id, VENUE_ID));
    await db.delete(schema.venues).where(eq(schema.venues.id, VENUE_ID));
    await expect(inspectProvisionTarget(db as never, VENUE_ID, "a@example.test")).rejects.toMatchObject({ code: "venue_not_found" });
    await createVenue();

    const owner = await createAuth().api.signUpEmail({ body: { name: "Existing Owner", email: "other-owner@example.test", password: GOOD_PASSWORD } });
    await db.insert(schema.venueMembers).values({ venueId: VENUE_ID, userId: owner.user.id, role: "owner" });
    await expect(inspectProvisionTarget(db as never, VENUE_ID, "another-owner@example.test")).rejects.toMatchObject({ code: "venue_already_owned" });
    await expect(inspectProvisionTarget(db as never, VENUE_ID, "other-owner@example.test")).rejects.toMatchObject({ code: "already_member" });

    const unlinked = await createAuth().api.signUpEmail({ body: { name: "Unlinked", email: "unlinked@example.test", password: GOOD_PASSWORD } });
    await expect(inspectProvisionTarget(db as never, VENUE_ID, "unlinked@example.test")).rejects.toMatchObject({ code: "existing_user_no_auto_grant" });
    expect(await db.select().from(schema.venueMembers).where(eq(schema.venueMembers.userId, unlinked.user.id))).toHaveLength(0);
  });

  it("retains an account after membership failure and provides a manual recovery marker", async () => {
    const email = "partial@example.test";
    const createAccount = request(email).createAccount;
    await expect(provisionStagingMerchant(request(email, {
      execute: true,
      createAccount,
      insertMembership: async () => { throw new Error("synthetic database failure"); },
    }))).rejects.toMatchObject({ code: "account_created_membership_failed", accountCreated: true });
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, email))).toHaveLength(1);
    expect(await db.select().from(schema.venueMembers)).toHaveLength(0);
    expect(formatProvisionResult({ kind: "partial-failure", venueId: VENUE_ID })).not.toMatch(GOOD_PASSWORD);
  });

  it("treats a Better Auth failure as uncertain and stops without assigning venue access", async () => {
    await expect(provisionStagingMerchant(request("uncertain@example.test", {
      execute: true,
      createAccount: async () => { throw new Error("synthetic connection failure"); },
    }))).rejects.toMatchObject({ code: "account_creation_uncertain", accountCreated: false });
    expect(await db.select().from(schema.venueMembers)).toHaveLength(0);
  });

  it("formats success and failure notices without emails, passwords, or database URLs", () => {
    const output = formatProvisionResult({ kind: "dry-run", venueId: VENUE_ID, venueName: VENUE_NAME });
    expect(output).not.toContain("owner@example.test");
    expect(output).not.toContain(GOOD_PASSWORD);
    expect(output).not.toContain("postgresql://");
  });

  it("fails closed when another provisioning run already holds the advisory lock", async () => {
    const acquired = await tryAcquireProvisionLock({
      query: async (sql, values) => {
        expect(sql).toContain("pg_try_advisory_lock");
        expect(values).toHaveLength(2);
        return { rows: [{ acquired: false }] };
      },
    });
    expect(acquired).toBe(false);
  });
});
