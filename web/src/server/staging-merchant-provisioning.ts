import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { MerchantAuthDb } from "../lib/merchant-auth-core";

export const STAGING_VENUE_ID = "961b6054-e798-4c19-9bbf-a11050c55047";
export const STAGING_VENUE_NAME = "Moonlight Staging 测试酒馆";
export const STAGING_DATABASE_HOST = "postgres.railway.internal";
export const STAGING_DATABASE_NAME = "railway";
export const STAGING_DATABASE_ROLE = "moonlight_staging_provisioner";
export const PROVISION_CONFIRMATION = "CREATE_STAGING_MERCHANT_OWNER";

export type StagingProvisionErrorCode =
  | "execute_confirmation_required"
  | "database_url_missing"
  | "database_url_invalid"
  | "database_host_not_approved"
  | "database_role_not_approved"
  | "database_privileges_not_approved"
  | "database_name_not_approved"
  | "database_identity_mismatch"
  | "venue_id_not_approved"
  | "input_invalid"
  | "venue_not_found"
  | "venue_name_mismatch"
  | "venue_inactive"
  | "already_member"
  | "existing_user_other_venue"
  | "existing_user_no_auto_grant"
  | "venue_already_owned"
  | "account_creation_uncertain"
  | "account_created_membership_failed"
  | "provision_lock_unavailable";

const SAFE_ERROR_MESSAGES: Record<StagingProvisionErrorCode, string> = {
  execute_confirmation_required: "写入需要 CLI 开关、专用环境确认和人工二次确认全部满足。",
  database_url_missing: "缺少专用 PROVISION_DATABASE_URL。",
  database_url_invalid: "专用数据库地址格式或协议无效；地址和凭据不会被打印。",
  database_host_not_approved: "数据库主机不是核准的 Railway Staging 私网主机。",
  database_role_not_approved: "数据库账号不是本次建号专用角色。",
  database_privileges_not_approved: "建号数据库角色具有禁止权限或角色继承；没有执行写入。",
  database_name_not_approved: "目标数据库不是核准的 railway Staging 数据库。",
  database_identity_mismatch: "数据库返回的身份与核准的 Staging 建号角色/数据库不一致。",
  venue_id_not_approved: "目标门店 UUID 不属于核准的 Staging 测试门店。",
  input_invalid: "姓名、邮箱、密码长度或密码确认不符合要求。",
  venue_not_found: "核准的 Staging 测试门店不存在；没有执行写入。",
  venue_name_mismatch: "目标门店名称与核准的 Staging 测试门店不一致；没有执行写入。",
  venue_inactive: "目标门店不是 active 状态；没有执行写入。",
  already_member: "该邮箱已经关联目标门店；不会重复创建或提升权限。",
  existing_user_other_venue: "该邮箱已有账号并关联其他门店；不会自动授予目标门店权限。",
  existing_user_no_auto_grant: "该邮箱已有账号但没有目标成员关系；不会自动授予权限。",
  venue_already_owned: "目标门店已有 active owner；本工具停止以避免意外增加所有者。",
  account_creation_uncertain: "Better Auth 建号结果无法确认。停止重试，先按手册只读核查账号和凭证记录。",
  account_created_membership_failed: "账号已创建，但 owner 关联失败。不要重试、删除账号或改密；先人工核查，再按手册恢复成员关联。",
  provision_lock_unavailable: "另一项建号操作正在运行或无法安全取得互斥锁；本次没有继续。",
};

export class StagingProvisionError extends Error {
  readonly code: StagingProvisionErrorCode;
  readonly accountCreated: boolean;

  constructor(code: StagingProvisionErrorCode, accountCreated = false) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "StagingProvisionError";
    this.code = code;
    this.accountCreated = accountCreated;
  }
}

export function validateStagingProvisionEnvironment(
  env: Record<string, string | undefined>,
  argv: string[],
): { execute: boolean } {
  if (env.NODE_ENV !== "production") {
    throw new Error("Staging provisioning requires NODE_ENV=production.");
  }
  if (env.DATABASE_URL) throw new Error("DATABASE_URL must be unset for the isolated provisioning process.");
  if (env.MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL must be unset for the isolated provisioning process.");
  if (!env.PROVISION_DATABASE_URL) throw new StagingProvisionError("database_url_missing");

  const execute = argv.includes("--execute");
  if (argv.some((argument) => argument !== "--execute" && argument !== "--dry-run")) {
    throw new Error("Only --dry-run or --execute is supported.");
  }
  if (execute && argv.includes("--dry-run")) throw new Error("Choose either --dry-run or --execute.");
  if (execute && (
    env.MOONLIGHT_STAGING_PROVISION !== "1"
    || env.MOONLIGHT_STAGING_PROVISION_CONFIRM !== PROVISION_CONFIRMATION
  )) {
    throw new StagingProvisionError("execute_confirmation_required");
  }
  return { execute };
}

export type ProvisionDatabaseTarget = { host: string; database: string; username: string };

export function validateProvisionDatabaseTarget(connectionString: string | undefined): ProvisionDatabaseTarget {
  if (!connectionString) throw new StagingProvisionError("database_url_missing");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StagingProvisionError("database_url_invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new StagingProvisionError("database_url_invalid");
  }
  if (url.hostname.toLowerCase() !== STAGING_DATABASE_HOST || url.port !== "5432") {
    throw new StagingProvisionError("database_host_not_approved");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== STAGING_DATABASE_NAME) {
    throw new StagingProvisionError("database_name_not_approved");
  }
  if (decodeURIComponent(url.username) !== STAGING_DATABASE_ROLE || !url.password) {
    throw new StagingProvisionError("database_role_not_approved");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "sslmode") throw new StagingProvisionError("database_url_invalid");
  }
  if (url.searchParams.has("sslmode") && !new Set(["require", "verify-ca", "verify-full"]).has(url.searchParams.get("sslmode") ?? "")) {
    throw new StagingProvisionError("database_url_invalid");
  }
  return { host: url.hostname.toLowerCase(), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username) };
}

export function assertStagingDatabaseIdentity(identity: {
  database: string;
  currentUser: string;
  sessionUser: string;
  inherit: boolean;
  hasRoleMemberships: boolean;
  superuser: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  bypassRls: boolean;
}) {
  if (identity.database !== STAGING_DATABASE_NAME) throw new StagingProvisionError("database_name_not_approved");
  if (identity.currentUser !== STAGING_DATABASE_ROLE || identity.sessionUser !== STAGING_DATABASE_ROLE) {
    throw new StagingProvisionError("database_role_not_approved");
  }
  if (identity.inherit || identity.hasRoleMemberships || identity.superuser || identity.createRole || identity.createDatabase || identity.replication || identity.bypassRls) {
    throw new StagingProvisionError("database_privileges_not_approved");
  }
}

export async function tryAcquireProvisionLock(client: {
  query: (sql: string, values: number[]) => Promise<{ rows: Array<{ acquired: boolean }> }>;
}) {
  const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [1297041230, 1296650840]);
  return result.rows[0]?.acquired === true;
}

export function validateProvisionInput(input: {
  venueId: string;
  name: string;
  email: string;
  password?: string;
  confirmation?: string;
  requirePassword?: boolean;
}) {
  if (input.venueId !== STAGING_VENUE_ID) throw new StagingProvisionError("venue_id_not_approved");
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new StagingProvisionError("input_invalid");
  }
  let password: string | undefined;
  if (input.requirePassword || input.password !== undefined || input.confirmation !== undefined) {
    if (
      typeof input.password !== "string"
      || input.password.length < 12
      || input.password.length > 128
      || input.password !== input.confirmation
    ) {
      throw new StagingProvisionError("input_invalid");
    }
    password = input.password;
  }
  return { venueId: input.venueId, name, email, password };
}

export async function inspectProvisionTarget(db: MerchantAuthDb, venueId: string, email: string) {
  if (venueId !== STAGING_VENUE_ID) throw new StagingProvisionError("venue_id_not_approved");
  const [venue] = await db.select({ id: schema.venues.id, name: schema.venues.name, status: schema.venues.status })
    .from(schema.venues).where(eq(schema.venues.id, venueId)).limit(1);
  if (!venue) throw new StagingProvisionError("venue_not_found");
  if (venue.name !== STAGING_VENUE_NAME) throw new StagingProvisionError("venue_name_mismatch");
  if (venue.status !== "active") throw new StagingProvisionError("venue_inactive");

  const [existingUser] = await db.select({ id: schema.authUsers.id })
    .from(schema.authUsers).where(eq(schema.authUsers.email, email)).limit(1);
  if (existingUser) {
    const memberships = await db.select({ venueId: schema.venueMembers.venueId })
      .from(schema.venueMembers).where(eq(schema.venueMembers.userId, existingUser.id));
    if (memberships.some((membership) => membership.venueId === venueId)) {
      throw new StagingProvisionError("already_member");
    }
    if (memberships.length > 0) throw new StagingProvisionError("existing_user_other_venue");
    throw new StagingProvisionError("existing_user_no_auto_grant");
  }

  const [owner] = await db.select({ userId: schema.venueMembers.userId })
    .from(schema.venueMembers)
    .where(and(
      eq(schema.venueMembers.venueId, venueId),
      eq(schema.venueMembers.role, "owner"),
      eq(schema.venueMembers.status, "active"),
    )).limit(1);
  if (owner) throw new StagingProvisionError("venue_already_owned");
  return { venueId: venue.id, venueName: venue.name };
}

type CreatedAccount = { user: { id: string } };

export async function provisionStagingMerchant(input: {
  db: MerchantAuthDb;
  venueId: string;
  venueName: string;
  name: string;
  email: string;
  password?: string;
  confirmation?: string;
  execute: boolean;
  createAccount: (account: { name: string; email: string; password: string }) => Promise<CreatedAccount>;
  insertMembership?: (venueId: string, userId: string) => Promise<unknown>;
}) {
  const validated = validateProvisionInput({ ...input, requirePassword: input.execute });
  const target = await inspectProvisionTarget(input.db, validated.venueId, validated.email);
  if (input.venueName !== target.venueName) throw new StagingProvisionError("venue_name_mismatch");
  if (!input.execute) return { kind: "dry-run" as const, ...target };

  let created: CreatedAccount;
  try {
    created = await input.createAccount({ name: validated.name, email: validated.email, password: validated.password! });
  } catch {
    throw new StagingProvisionError("account_creation_uncertain");
  }
  try {
    if (input.insertMembership) await input.insertMembership(validated.venueId, created.user.id);
    else await input.db.insert(schema.venueMembers).values({ venueId: validated.venueId, userId: created.user.id, role: "owner", status: "active" });
  } catch {
    throw new StagingProvisionError("account_created_membership_failed", true);
  }
  return { kind: "created" as const, venueId: validated.venueId, role: "owner" as const };
}

export function formatProvisionResult(result: { kind: "dry-run"; venueId: string; venueName: string } | { kind: "created"; venueId: string; role: "owner" } | { kind: "partial-failure"; venueId: string }) {
  if (result.kind === "dry-run") return `只读检查通过：目标为 ${result.venueName}（${result.venueId}）；该邮箱尚无账号；未写入数据。`;
  if (result.kind === "created") return `Staging 商家账号已创建，并已关联指定门店 owner 权限（${result.venueId}）。`;
  return `账号与成员关系状态需要人工核查（门店 ${result.venueId}）。`;
}
