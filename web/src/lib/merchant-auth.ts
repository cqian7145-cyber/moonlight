import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { getDb } from "../db";

export type MerchantAuthDb = ReturnType<typeof getDb>;

type MerchantAuthOptions = {
  baseURL: string;
  secret: string;
  allowProvisioning?: boolean;
  secureCookies?: boolean;
};

export function createMerchantAuth(db: MerchantAuthDb, options: MerchantAuthOptions) {
  const baseUrl = new URL(options.baseURL);
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "[::1]") {
    throw new Error("Merchant authentication requires HTTPS outside loopback.");
  }
  if (options.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");

  return betterAuth({
    appName: "Moonlight Merchant",
    baseURL: baseUrl.origin,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: [baseUrl.origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        authUsers: schema.authUsers,
        authSessions: schema.authSessions,
        authAccounts: schema.authAccounts,
        authVerifications: schema.authVerifications,
        authRateLimits: schema.authRateLimits,
      },
    }),
    user: {
      modelName: "authUsers",
      additionalFields: {
        disabled: { type: "boolean", required: false, defaultValue: false, input: false, returned: false },
      },
    },
    session: { modelName: "authSessions", expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.allowProvisioning,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimits",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      trustedProxyHeaders: false,
      ipAddress: { ipAddressHeaders: [] },
      useSecureCookies: options.secureCookies ?? process.env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: options.secureCookies ?? process.env.NODE_ENV === "production",
        path: "/",
      },
      cookiePrefix: "moonlight_merchant",
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [user] = await db.select({ disabled: schema.authUsers.disabled })
              .from(schema.authUsers).where(eq(schema.authUsers.id, session.userId)).limit(1);
            if (!user || user.disabled) {
              throw new APIError("UNAUTHORIZED", { message: "邮箱或密码错误" });
            }
          },
        },
      },
    },
  });
}

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
