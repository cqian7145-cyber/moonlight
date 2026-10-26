import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Client } from "pg";
import { test } from "node:test";
import { runStagingMigrations, validateMigrationEnvironment } from "./migrate-staging.mjs";

const connectionString = process.env.M014S2_MIGRATION_TEST_DATABASE_URL;
const recoveryConnectionString = process.env.M014S2_MIGRATION_RECOVERY_TEST_DATABASE_URL;
const enabled = Boolean(connectionString && recoveryConnectionString);

function runnerEnv(databaseUrl = connectionString) {
  return {
    MOONLIGHT_MIGRATION_RUN: "1",
    MOONLIGHT_MIGRATION_TARGET: "local-test",
    MOONLIGHT_MIGRATION_CONFIRM: "I_UNDERSTAND_THIS_RUNS_DATABASE_MIGRATIONS",
    MIGRATION_DATABASE_URL: databaseUrl,
  };
}

async function assertNoApplicationData(client) {
  const { rows: tables } = await client.query(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename } of tables) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM public.${quoted}`);
    assert.equal(rows[0]?.count, 0, "migration verification database must not contain application data");
  }
}

test("real PostgreSQL runner is idempotent, detects ledger drift, and rejects a concurrent runner", { skip: !enabled }, async () => {
  validateMigrationEnvironment(runnerEnv());
  const observer = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await observer.connect();
  try {
    await assertNoApplicationData(observer);

    const first = await runStagingMigrations({ env: runnerEnv() });
    const second = await runStagingMigrations({ env: runnerEnv() });
    assert.deepEqual(first, { target: "local-test", migrationCount: 4 });
    assert.deepEqual(second, first);

    const ledger = await observer.query(
      "SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id",
    );
    assert.equal(ledger.rows.length, 4);
    const originalHash = ledger.rows[0].hash;
    await observer.query("UPDATE drizzle.__drizzle_migrations SET hash = 'tampered-test-hash' WHERE id = $1", [ledger.rows[0].id]);
    try {
      await assert.rejects(runStagingMigrations({ env: runnerEnv() }), /ledger does not match/i);
    } finally {
      await observer.query("UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE id = $2", [originalHash, ledger.rows[0].id]);
    }

    await observer.query("SELECT pg_advisory_lock($1, $2)", [1297041230, 1296650823]);
    try {
      await assert.rejects(runStagingMigrations({ env: runnerEnv() }), /another migration runner/i);
    } finally {
      await observer.query("SELECT pg_advisory_unlock($1, $2)", [1297041230, 1296650823]);
    }

    await assertNoApplicationData(observer);
  } finally {
    await observer.end();
  }

  const recoveryEnv = runnerEnv(recoveryConnectionString);
  validateMigrationEnvironment(recoveryEnv);
  const recoveryClient = new Client({ connectionString: recoveryEnv.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await recoveryClient.connect();
  const tempBase = resolve(process.cwd(), "..", ".tmp");
  let fixtureFolder;
  try {
    await mkdir(tempBase, { recursive: true });
    fixtureFolder = await mkdtemp(join(tempBase, "moonlight-migration-fixture-"));
    await mkdir(join(fixtureFolder, "meta"), { recursive: true });
    await writeFile(join(fixtureFolder, "meta", "_journal.json"), JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1790000000000, tag: "0000_setup", breakpoints: true },
        { idx: 1, version: "7", when: 1790000000001, tag: "0001_recoverable", breakpoints: true },
      ],
    }));
    await writeFile(join(fixtureFolder, "0000_setup.sql"), "CREATE TABLE public.migration_recovery_marker (id integer PRIMARY KEY);\n");
    const secondMigrationPath = join(fixtureFolder, "0001_recoverable.sql");
    const recoverySql = "CREATE TABLE public.migration_recovery_complete (id integer PRIMARY KEY);\n";
    const existingLedger = await recoveryClient.query("SELECT id FROM drizzle.__drizzle_migrations ORDER BY id").catch(() => ({ rows: [] }));
    if (existingLedger.rows.length === 2) {
      await assertNoApplicationData(recoveryClient);
      await writeFile(secondMigrationPath, recoverySql);
      const rerun = await runStagingMigrations({ env: recoveryEnv, migrationsFolder: fixtureFolder });
      assert.deepEqual(rerun, { target: "local-test", migrationCount: 2 });
      return;
    }

    assert.ok(existingLedger.rows.length <= 1, "recovery database may contain only the first committed migration");
    await assertNoApplicationData(recoveryClient);
    await writeFile(secondMigrationPath, "THIS IS NOT VALID SQL;\n");

    await assert.rejects(
      runStagingMigrations({ env: recoveryEnv, migrationsFolder: fixtureFolder }),
      (error) => error?.cause?.code === "42601",
    );
    const failedLedger = await recoveryClient.query("SELECT id FROM drizzle.__drizzle_migrations ORDER BY id");
    assert.deepEqual(failedLedger.rows, [], "a failed migration batch must not record a partial version");
    const markerAfterFailure = await recoveryClient.query("SELECT to_regclass('public.migration_recovery_marker') IS NOT NULL AS present");
    assert.equal(markerAfterFailure.rows[0]?.present, false, "the failed Drizzle transaction must roll back prior statements in its batch");

    await writeFile(secondMigrationPath, recoverySql);
    const recovered = await runStagingMigrations({ env: recoveryEnv, migrationsFolder: fixtureFolder });
    assert.deepEqual(recovered, { target: "local-test", migrationCount: 2 });
    const fullLedger = await recoveryClient.query("SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id");
    assert.equal(fullLedger.rows.length, 2);
    assert.ok(fullLedger.rows[0].id < fullLedger.rows[1].id, "migration ledger ids must remain ordered but may contain sequence gaps");
    assert.deepEqual(fullLedger.rows.map((row) => row.created_at), ["1790000000000", "1790000000001"]);
  } finally {
    await recoveryClient.end();
    if (fixtureFolder) {
      const safeBase = await realpath(tempBase);
      const safeFixture = await realpath(fixtureFolder);
      assert.ok(safeFixture.startsWith(`${safeBase}${sep}`), "temporary migration fixture must stay within D-drive .tmp");
      const journal = await readFile(join(safeFixture, "meta", "_journal.json"), "utf8");
      assert.ok(journal.includes("0001_recoverable"), "cleanup is restricted to the fixture created by this test");
      await rm(safeFixture, { recursive: true });
    }
  }
});
