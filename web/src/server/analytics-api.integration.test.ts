import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth";
import { createAnalyticsApiHandlers } from "./analytics-api";

const origin = "http://localhost:3000";
const secret = "test-secret-with-at-least-thirty-two-characters";
let client: PGlite;
let db: ReturnType<typeof drizzle>;
function request(path: string, cookie?: string) {
  return new Request(`${origin}${path}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } });
}
async function account(role: "owner" | "staff" | "outsider", venueId?: string) {
  const auth = createMerchantAuth(db as never, { baseURL: origin, secret, allowProvisioning: true });
  const email = `${role}-${crypto.randomUUID()}@example.test`;
  const password = `Test-${crypto.randomUUID()}-A9!`;
  const user = await auth.api.signUpEmail({ body: { name: "虚构测试账号", email, password } });
  if (venueId && role !== "outsider") await db.insert(schema.venueMembers).values({ venueId, userId: user.user.id, role });
  const signed = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { host: "localhost:3000", origin, "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
  const cookie = (signed.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  return { cookie, auth: createMerchantAuth(db as never, { baseURL: origin, secret }) };
}

describe("merchant analytics HTTP authorization", () => {
  beforeEach(async () => { client = new PGlite(); db = drizzle(client, { schema }); await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") }); });
  afterEach(async () => client.close());

  it("allows active owner and staff to read only their venue and rejects outsiders", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "授权门店 A" }).returning();
    const [other] = await db.insert(schema.venues).values({ name: "授权门店 B" }).returning();
    const owner = await account("owner", venue!.id);
    const staff = await account("staff", venue!.id);
    const outsider = await account("outsider");
    const handler = createAnalyticsApiHandlers(db as never, owner.auth);
    expect((await handler.get(request(`/api/merchant/venues/${venue!.id}/analytics?period=7d`, owner.cookie), venue!.id)).status).toBe(200);
    expect((await handler.get(request(`/api/merchant/venues/${venue!.id}/analytics?period=30d`, staff.cookie), venue!.id)).status).toBe(200);
    const denied = await handler.get(request(`/api/merchant/venues/${venue!.id}/analytics`, outsider.cookie), venue!.id);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    expect((await handler.get(request(`/api/merchant/venues/${other!.id}/analytics`, owner.cookie), other!.id)).status).toBe(403);
    expect((await handler.get(request(`/api/merchant/venues/${venue!.id}/analytics?period=999d`, owner.cookie), venue!.id)).status).toBe(400);
    expect((await handler.get(request(`/api/merchant/venues/${venue!.id}/analytics`), venue!.id)).status).toBe(401);
  });
});
