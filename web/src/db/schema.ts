import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  text,
  uniqueIndex,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

export type ActivityContent = {
  title?: string;
  cues: readonly {
    key: string;
    prompt: string;
    choices: readonly string[];
  }[];
};

export type ActivityDraftContent = { title: string; cues: ActivityContent["cues"] };

export const venueStatus = pgEnum("venue_status", ["active", "suspended", "archived"]);
export const templateStatus = pgEnum("template_status", ["draft", "archived"]);
export const publicationStatus = pgEnum("publication_status", ["active", "inactive"]);
export const playGroupStatus = pgEnum("play_group_status", ["open", "paired", "expired", "cancelled"]);
export const attemptMode = pgEnum("attempt_mode", ["solo", "duo"]);
export const attemptStatus = pgEnum("attempt_status", ["in_progress", "completed", "abandoned"]);
export const venueMemberRole = pgEnum("venue_member_role", ["owner", "staff"]);
export const venueMemberStatus = pgEnum("venue_member_status", ["active", "disabled"]);

// Better Auth's standard Drizzle schema, isolated from public gameplay data.
export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const authVerifications = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const authRateLimits = pgTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const venues = pgTable("venues", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Shanghai"),
  status: venueStatus("status").notNull().default("active"),
  createdAt: createdAt(),
}, (table) => [
  check("venues_name_nonempty", sql`length(trim(${table.name})) > 0`),
  check("venues_timezone_nonempty", sql`length(trim(${table.timezone})) > 0`),
]);

export const venueMembers = pgTable("venue_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  role: venueMemberRole("role").notNull(),
  status: venueMemberStatus("status").notNull().default("active"),
  createdAt: createdAt(),
}, (table) => [
  unique("venue_members_venue_user_unique").on(table.venueId, table.userId),
  index("venue_members_user_status_idx").on(table.userId, table.status),
]);

export const venueTables = pgTable("venue_tables", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull().references(() => venues.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 80 }).notNull(),
  publicCodeHash: varchar("public_code_hash", { length: 128 }).notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("venue_tables_public_code_hash_unique").on(table.publicCodeHash),
  unique("venue_tables_id_venue_unique").on(table.id, table.venueId),
  check("venue_tables_name_nonempty", sql`length(trim(${table.name})) > 0`),
  check("venue_tables_public_code_hash_nonempty", sql`length(trim(${table.publicCodeHash})) > 0`),
]);

export const activityTemplates = pgTable("activity_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull().references(() => venues.id, { onDelete: "restrict" }),
  title: varchar("title", { length: 160 }).notNull(),
  draftContent: jsonb("draft_content").$type<ActivityDraftContent | null>(),
  status: templateStatus("status").notNull().default("draft"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  unique("activity_templates_id_venue_unique").on(table.id, table.venueId),
  check("activity_templates_title_nonempty", sql`length(trim(${table.title})) > 0`),
  check("activity_templates_draft_content_shape", sql`${table.draftContent} IS NULL OR (
    jsonb_typeof(${table.draftContent}) = 'object' AND
    CASE WHEN jsonb_typeof(${table.draftContent} -> 'title') = 'string'
      AND length(trim(${table.draftContent} ->> 'title')) > 0
      AND jsonb_typeof(${table.draftContent} -> 'cues') = 'array'
    THEN jsonb_array_length(${table.draftContent} -> 'cues') = 3
    ELSE false END
  )`),
]);

export const activityVersions = pgTable("activity_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull(),
  templateId: uuid("template_id").notNull(),
  versionNo: integer("version_no").notNull(),
  content: jsonb("content").$type<ActivityContent>().notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "activity_versions_template_venue_fk",
    columns: [table.templateId, table.venueId],
    foreignColumns: [activityTemplates.id, activityTemplates.venueId],
  }).onDelete("restrict"),
  uniqueIndex("activity_versions_template_version_unique").on(table.templateId, table.versionNo),
  unique("activity_versions_id_venue_unique").on(table.id, table.venueId),
  check("activity_versions_positive_version", sql`${table.versionNo} > 0`),
  check(
    "activity_versions_has_cues",
    sql`jsonb_typeof(${table.content}) = 'object' AND CASE
      WHEN jsonb_typeof(${table.content} -> 'cues') = 'array'
      THEN jsonb_array_length(${table.content} -> 'cues') > 0
      ELSE false
    END`,
  ),
]);

export const publications = pgTable("publications", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull().references(() => venues.id, { onDelete: "restrict" }),
  versionId: uuid("version_id").notNull(),
  status: publicationStatus("status").notNull().default("active"),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "publications_version_venue_fk",
    columns: [table.versionId, table.venueId],
    foreignColumns: [activityVersions.id, activityVersions.venueId],
  }).onDelete("restrict"),
  unique("publications_id_venue_unique").on(table.id, table.venueId),
  uniqueIndex("publications_one_active_per_venue").on(table.venueId).where(sql`${table.status} = 'active'`),
  check(
    "publications_status_timestamps_match",
    sql`(${table.status} = 'active' AND ${table.deactivatedAt} IS NULL)
      OR (${table.status} = 'inactive' AND ${table.deactivatedAt} IS NOT NULL)`,
  ),
  check("publications_deactivation_after_activation", sql`${table.deactivatedAt} IS NULL OR ${table.deactivatedAt} >= ${table.activatedAt}`),
]);

export const playGroups = pgTable("play_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  venueId: uuid("venue_id").notNull(),
  publicationId: uuid("publication_id").notNull(),
  tableId: uuid("table_id"),
  inviteCodeHash: varchar("invite_code_hash", { length: 128 }).notNull(),
  status: playGroupStatus("status").notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "play_groups_publication_venue_fk",
    columns: [table.publicationId, table.venueId],
    foreignColumns: [publications.id, publications.venueId],
  }).onDelete("restrict"),
  foreignKey({
    name: "play_groups_table_venue_fk",
    columns: [table.tableId, table.venueId],
    foreignColumns: [venueTables.id, venueTables.venueId],
  }).onDelete("restrict"),
  uniqueIndex("play_groups_invite_code_hash_unique").on(table.inviteCodeHash),
  unique("play_groups_id_publication_unique").on(table.id, table.publicationId),
  check("play_groups_invite_code_hash_nonempty", sql`length(trim(${table.inviteCodeHash})) > 0`),
  check("play_groups_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const attempts = pgTable("attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  publicationId: uuid("publication_id").notNull(),
  playGroupId: uuid("play_group_id"),
  mode: attemptMode("mode").notNull().default("solo"),
  status: attemptStatus("status").notNull().default("in_progress"),
  sessionTokenHash: varchar("session_token_hash", { length: 128 }).notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true, mode: "date" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "attempts_group_publication_fk",
    columns: [table.playGroupId, table.publicationId],
    foreignColumns: [playGroups.id, playGroups.publicationId],
  }).onDelete("restrict"),
  foreignKey({
    name: "attempts_publication_fk",
    columns: [table.publicationId],
    foreignColumns: [publications.id],
  }).onDelete("restrict"),
  uniqueIndex("attempts_session_token_hash_unique").on(table.sessionTokenHash),
  check("attempts_session_token_hash_nonempty", sql`length(trim(${table.sessionTokenHash})) > 0`),
  check(
    "attempts_mode_group_consent_match",
    sql`(${table.mode} = 'solo' AND ${table.playGroupId} IS NULL AND ${table.consentedAt} IS NULL)
      OR (${table.mode} = 'duo' AND ${table.playGroupId} IS NOT NULL AND ${table.consentedAt} IS NOT NULL)`,
  ),
  check(
    "attempts_completion_timestamp_matches_status",
    sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)
      OR (${table.status} <> 'completed' AND ${table.completedAt} IS NULL)`,
  ),
  check("attempts_completion_after_start", sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`),
]);

export const submissions = pgTable("submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
  cueKey: varchar("cue_key", { length: 100 }).notNull(),
  answer: jsonb("answer").$type<unknown>().notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("submissions_attempt_cue_unique").on(table.attemptId, table.cueKey),
  check("submissions_cue_key_nonempty", sql`length(trim(${table.cueKey})) > 0`),
]);

export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("feedback_attempt_unique").on(table.attemptId),
  check("feedback_rating_in_range", sql`${table.rating} BETWEEN 1 AND 5`),
]);
