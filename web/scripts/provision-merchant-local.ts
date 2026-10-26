import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "../src/db/schema";

function getLocalDatabaseUrl() {
  if (!process.argv.includes("--local-provision") || process.env.NODE_ENV === "production") {
    throw new Error("Run this utility only with --local-provision outside production.");
  }
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("Set DATABASE_URL to the isolated local Moonlight database.");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("DATABASE_URL must be a valid local PostgreSQL URL."); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase()) || url.pathname !== "/moonlight_dev" || url.port !== "55432") {
    throw new Error("This utility only accepts the isolated moonlight_dev database on loopback port 55432.");
  }
  return value;
}

async function readHidden(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Password entry requires an interactive terminal.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("Provisioning cancelled."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\b" || char === "\u007f") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u001b") value += char;
      }
    };
    stdin.on("data", onData);
    stdin.once("error", finish);
  });
}

async function main() {
  const connectionString = getLocalDatabaseUrl();
  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle({ client: pool, schema });
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const venueId = (await prompt.question("门店 ID：")).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(venueId)) throw new Error("Enter a valid venue UUID.");
    const venue = await pool.query("SELECT id FROM venues WHERE id = $1 LIMIT 1", [venueId]);
    if (!venue.rowCount) throw new Error("The selected venue does not exist in this local database.");
    const name = (await prompt.question("商家姓名：")).trim();
    const email = (await prompt.question("商家邮箱：")).trim().toLowerCase();
    const role = (await prompt.question("角色（owner/staff）：")).trim();
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !["owner", "staff"].includes(role)) {
      throw new Error("Name, email, or role is invalid.");
    }
    prompt.close();

    const password = await readHidden("新密码（至少 12 位）：");
    const confirmation = await readHidden("再次输入新密码：");
    if (password.length < 12 || password.length > 128 || password !== confirmation) {
      throw new Error("Password length or confirmation is invalid.");
    }
    const confirmPrompt = createInterface({ input: stdin, output: stdout });
    const confirmationText = await confirmPrompt.question(`将为指定门店创建 ${role} 账号。输入 PROVISION 继续：`);
    confirmPrompt.close();
    if (confirmationText.trim() !== "PROVISION") throw new Error("Provisioning was not confirmed.");

    const auth = betterAuth({
      appName: "Moonlight Local Provisioning",
      baseURL: "http://localhost:3000",
      basePath: "/api/auth",
      secret: randomBytes(48).toString("base64url"),
      trustedOrigins: ["http://localhost:3000"],
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
      user: { modelName: "authUsers", additionalFields: { disabled: { type: "boolean", required: false, defaultValue: false, input: false, returned: false } } },
      account: { modelName: "authAccounts" },
      session: { modelName: "authSessions" },
      verification: { modelName: "authVerifications" },
      emailAndPassword: { enabled: true, disableSignUp: false, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false },
    });
    const created = await auth.api.signUpEmail({ body: { name, email, password } });
    await db.insert(schema.venueMembers).values({ venueId, userId: created.user.id, role: role as "owner" | "staff" });
    stdout.write("本地商家账号已创建并关联所选门店。账号凭据未显示。\n");
  } finally {
    prompt.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Local provisioning failed.";
  console.error(message);
  process.exitCode = 1;
});
