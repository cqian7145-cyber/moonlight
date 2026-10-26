import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const CONFIRMATION = "I_UNDERSTAND_THIS_RUNS_DATABASE_MIGRATIONS";
const LOCK_KEY = [1297041230, 1296650823];
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_FOLDER = resolve(SCRIPT_DIR, "../drizzle");

export function validateMigrationEnvironment(env) {
  if (env.MOONLIGHT_MIGRATION_RUN !== "1") {
    throw new Error("Explicit opt-in is required (MOONLIGHT_MIGRATION_RUN=1).");
  }

  if (env.DATABASE_URL) {
    throw new Error("DATABASE_URL is forbidden in the isolated migration runner; use its dedicated environment only.");
  }

  const target = env.MOONLIGHT_MIGRATION_TARGET;
  if (target !== "staging" && target !== "local-test") {
    throw new Error("MOONLIGHT_MIGRATION_TARGET must be staging or local-test.");
  }
  if (env.MOONLIGHT_MIGRATION_CONFIRM !== CONFIRMATION) {
    throw new Error("An exact migration confirmation is required.");
  }

  const connectionString = env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required.");

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("MIGRATION_DATABASE_URL must use PostgreSQL.");
  }
  if (url.username.length === 0) throw new Error("The migration database role must have a dedicated username.");
  if (url.hash || url.searchParams.has("options")) {
    throw new Error("MIGRATION_DATABASE_URL contains unsupported connection options.");
  }

  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error("MIGRATION_DATABASE_URL must select a database.");

  if (target === "local-test") {
    if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) {
      throw new Error("local-test only accepts a loopback PostgreSQL host.");
    }
    if (!new Set([
      "moonlight_m014s2_migration_test",
      "moonlight_m014s2_migration_recovery_test",
      "moonlight_m014s2_migration_recovery_fresh_test",
    ]).has(database)) {
      throw new Error("local-test only accepts the dedicated migration test database.");
    }
  } else {
    if (!host.endsWith(".railway.internal")) {
      throw new Error("staging only accepts a private Railway hostname.");
    }
    if (url.password.length === 0) throw new Error("The staging migration role must use a secret password.");
    if (env.NODE_ENV !== "production") {
      throw new Error("staging migrations require NODE_ENV=production.");
    }
  }

  return { target, host, database, connectionString };
}

export function requireCliConfirmation(argv) {
  if (!argv.includes("--confirm-staging-migrations")) {
    throw new Error("Explicit command confirmation is required (--confirm-staging-migrations).");
  }
}

async function readExpectedMigrations(migrationsFolder) {
  const journal = JSON.parse(await readFile(resolve(migrationsFolder, "meta/_journal.json"), "utf8"));
  if (journal.dialect !== "postgresql" || !Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("The checked-in PostgreSQL migration journal is invalid.");
  }

  const expected = [];
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index || typeof entry.tag !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.tag)) {
      throw new Error("The checked-in PostgreSQL migration journal has an invalid entry.");
    }
    const sql = await readFile(resolve(migrationsFolder, `${entry.tag}.sql`));
    expected.push({
      tag: entry.tag,
      hash: createHash("sha256").update(sql).digest("hex"),
      createdAt: String(entry.when),
    });
  }
  return expected;
}

async function verifyLedger(client, expected, { allowMissing = false } = {}) {
  const exists = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
  if (!exists.rows[0]?.present) {
    if (allowMissing) {
      const tables = await client.query(
        "SELECT count(*)::int AS count FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
      );
      if (tables.rows[0]?.count !== 0) {
        throw new Error("Refusing to initialize a non-empty database without a Drizzle migration ledger.");
      }
      return false;
    }
    throw new Error("The migration ledger was not created.");
  }

  const { rows } = await client.query(
    "SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  if (rows.length > expected.length) throw new Error("The database migration ledger is newer than this release.");
  for (const [index, row] of rows.entries()) {
    const migration = expected[index];
    if (!migration || row.hash !== migration.hash || row.created_at !== migration.createdAt) {
      throw new Error("The database migration ledger does not match the immutable migration files.");
    }
  }
  if (!allowMissing && rows.length !== expected.length) {
    throw new Error("The database migration ledger is incomplete after migration.");
  }
  return true;
}

export async function runStagingMigrations({
  env = process.env,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
  clientFactory = (connectionString) => new Client({
    connectionString,
    application_name: "moonlight-staging-migration-runner",
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  }),
} = {}) {
  const config = validateMigrationEnvironment(env);
  const expected = await readExpectedMigrations(migrationsFolder);
  const client = clientFactory(config.connectionString);
  let connected = false;
  let locked = false;
  try {
    await client.connect();
    connected = true;
    const lockResult = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", LOCK_KEY);
    locked = Boolean(lockResult.rows[0]?.acquired);
    if (!locked) throw new Error("Another migration runner currently holds the database lock.");

    await verifyLedger(client, expected, { allowMissing: true });
    await migrate(drizzle(client), { migrationsFolder });
    await verifyLedger(client, expected);
    return { target: config.target, migrationCount: expected.length };
  } finally {
    if (connected && locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", LOCK_KEY);
      } catch {
        // Closing the session releases a session-level advisory lock.
      }
    }
    if (connected) await client.end();
  }
}

function safeFailureDescription(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? `Database operation failed (SQLSTATE ${code}).`
    : "Migration runner failed; connection details and SQL are withheld.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireCliConfirmation(process.argv.slice(2));
    const result = await runStagingMigrations();
    console.log(`Verified ${result.migrationCount} checked-in PostgreSQL migrations for target ${result.target}.`);
  } catch (error) {
    console.error(safeFailureDescription(error));
    process.exitCode = 1;
  }
}
