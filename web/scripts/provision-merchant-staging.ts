import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { createMerchantAuth } from "../src/lib/merchant-auth-core";
import {
  assertStagingDatabaseIdentity,
  formatProvisionResult,
  inspectProvisionTarget,
  PROVISION_CONFIRMATION,
  provisionStagingMerchant,
  STAGING_VENUE_ID,
  STAGING_VENUE_NAME,
  StagingProvisionError,
  tryAcquireProvisionLock,
  validateProvisionDatabaseTarget,
  validateProvisionInput,
  validateStagingProvisionEnvironment,
} from "../src/server/staging-merchant-provisioning";

async function askLine(message: string) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question(message)).trim();
  } finally {
    prompt.close();
  }
}

async function readHidden(message: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("需要支持 TTY 隐藏输入的交互终端；本次未写入。不要改用命令行密码参数或日志。");
  }
  stdout.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      stdin.off("data", onData);
      stdin.off("error", onError);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onError = () => finish(new Error("隐藏密码输入失败；本次未写入。"));
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("操作已取消；本次未写入。"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\b" || char === "\u007f") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u001b") value += char;
      }
    };
    stdin.on("data", onData);
    stdin.once("error", onError);
  });
}

function safeFailure(error: unknown) {
  if (error instanceof StagingProvisionError) return error.message;
  if (error instanceof Error && error.message.startsWith("需要支持 TTY")) return error.message;
  if (error instanceof Error && error.message.startsWith("操作已取消")) return error.message;
  return "操作已安全停止。连接信息、邮箱、密码和底层数据库错误均未输出；请先只读检查状态，再决定下一步。";
}

async function main() {
  if (process.argv.includes("--help")) {
    stdout.write("默认执行只读 dry-run；正式写入需 --execute、专用环境确认及终端二次确认。\n");
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("需要交互式 TTY；不支持管道、自动化或密码参数。未连接数据库。");

  const mode = validateStagingProvisionEnvironment(process.env, process.argv.slice(2));
  const rawConnectionString = process.env.PROVISION_DATABASE_URL;
  const databaseTarget = validateProvisionDatabaseTarget(rawConnectionString);
  const venueId = await askLine("核对目标 Staging 测试门店 UUID：");
  const typedVenueName = await askLine("核对目标门店名称：");
  const name = await askLine("商家姓名：");
  const email = await askLine("商家邮箱：");
  if (venueId !== STAGING_VENUE_ID || typedVenueName !== STAGING_VENUE_NAME) {
    throw new StagingProvisionError("venue_id_not_approved");
  }
  const basicInput = validateProvisionInput({ venueId, name, email });

  const pool = new Pool({
    connectionString: rawConnectionString,
    max: 4,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    application_name: "moonlight-staging-merchant-provisioner",
  });
  let lockClient: PoolClient | undefined;
  let lockHeld = false;
  try {
    lockClient = await pool.connect();
    const identityResult = await lockClient.query<{
      database: string;
      current_user: string;
      session_user: string;
      rolinherit: boolean;
      has_role_memberships: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT current_database() AS database, current_user, session_user, r.rolinherit, EXISTS (SELECT 1 FROM pg_auth_members AS m WHERE m.member = r.oid) AS has_role_memberships, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    const identity = identityResult.rows[0];
    if (!identity) throw new StagingProvisionError("database_identity_mismatch");
    assertStagingDatabaseIdentity({
      database: identity.database,
      currentUser: identity.current_user,
      sessionUser: identity.session_user,
      inherit: identity.rolinherit,
      hasRoleMemberships: identity.has_role_memberships,
      superuser: identity.rolsuper,
      createRole: identity.rolcreaterole,
      createDatabase: identity.rolcreatedb,
      replication: identity.rolreplication,
      bypassRls: identity.rolbypassrls,
    });
    if (databaseTarget.host !== "postgres.railway.internal") {
      throw new StagingProvisionError("database_host_not_approved");
    }
    lockHeld = await tryAcquireProvisionLock(lockClient);
    if (!lockHeld) throw new StagingProvisionError("provision_lock_unavailable");

    const db = drizzle({ client: pool, schema });
    await inspectProvisionTarget(db as never, basicInput.venueId, basicInput.email);
    let password: string | undefined;
    let confirmation: string | undefined;
    if (mode.execute) {
      password = await readHidden("新商家密码（输入不回显）：");
      confirmation = await readHidden("再次输入密码：");
      validateProvisionInput({ ...basicInput, password, confirmation, requirePassword: true });
      const finalConfirmation = await askLine(`输入 ${PROVISION_CONFIRMATION} 再次确认写入：`);
      if (finalConfirmation !== PROVISION_CONFIRMATION) {
        throw new StagingProvisionError("execute_confirmation_required");
      }
    }

    const auth = createMerchantAuth(db as never, {
      // This CLI invokes signUpEmail directly and auto sign-in is disabled; no HTTP origin or session is created.
      baseURL: "https://provisioning.moonlight.invalid",
      secret: randomBytes(48).toString("base64url"),
      allowProvisioning: true,
      secureCookies: true,
      adapterTransaction: true,
      loggerDisabled: true,
    });
    const result = await provisionStagingMerchant({
      db: db as never,
      venueId: basicInput.venueId,
      venueName: typedVenueName,
      name: basicInput.name,
      email: basicInput.email,
      password,
      confirmation,
      execute: mode.execute,
      createAccount: (account) => auth.api.signUpEmail({ body: account }),
    });
    stdout.write(`${formatProvisionResult(result)}\n`);
  } finally {
    if (lockClient && lockHeld) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [1297041230, 1296650840]);
      } catch {
        // Releasing the client also releases its session-level lock.
      }
    }
    lockClient?.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(safeFailure(error));
  process.exitCode = 1;
});
