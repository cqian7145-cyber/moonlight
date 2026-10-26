import assert from "node:assert/strict";
import { test } from "node:test";
import { requireCliConfirmation, validateMigrationEnvironment } from "./migrate-staging.mjs";

const confirm = "I_UNDERSTAND_THIS_RUNS_DATABASE_MIGRATIONS";

function connectionUrl(host, port, database, { password = "" } = {}) {
  const url = new URL(`postgresql://${host}:${port}/${database}`);
  url.username = "migration_test_role";
  if (password) url.password = password;
  return url.toString();
}

function env(overrides = {}) {
  return {
    MOONLIGHT_MIGRATION_RUN: "1",
    MOONLIGHT_MIGRATION_TARGET: "local-test",
    MOONLIGHT_MIGRATION_CONFIRM: confirm,
    MIGRATION_DATABASE_URL: connectionUrl("127.0.0.1", 55433, "moonlight_m014s2_migration_test"),
    ...overrides,
  };
}

test("runner requires explicit opt-in, a dedicated migration URL, and an isolated local test database", () => {
  assert.throws(() => validateMigrationEnvironment(env({ MOONLIGHT_MIGRATION_RUN: "0" })), /explicit opt-in/i);
  assert.throws(() => validateMigrationEnvironment(env({ MIGRATION_DATABASE_URL: undefined })), /MIGRATION_DATABASE_URL/i);
  assert.throws(() => validateMigrationEnvironment(env({ DATABASE_URL: "application-url-is-present" })), /DATABASE_URL/i);
  assert.throws(() => validateMigrationEnvironment(env({ MIGRATION_DATABASE_URL: connectionUrl("db.example.com", 5432, "moonlight") })), /loopback/i);
  assert.throws(() => validateMigrationEnvironment(env({ MIGRATION_DATABASE_URL: connectionUrl("127.0.0.1", 55432, "moonlight_dev") })), /dedicated migration test database/i);

  const config = validateMigrationEnvironment(env());
  assert.equal(config.target, "local-test");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.database, "moonlight_m014s2_migration_test");
});

test("staging mode accepts only a private Railway hostname and an exact human confirmation", () => {
  const staging = env({
    NODE_ENV: "production",
    MOONLIGHT_MIGRATION_TARGET: "staging",
    MOONLIGHT_MIGRATION_CONFIRM: confirm,
    MIGRATION_DATABASE_URL: connectionUrl("moonlight-postgres.railway.internal", 5432, "moonlight", { password: "x" }),
  });
  assert.equal(validateMigrationEnvironment(staging).target, "staging");
  assert.throws(() => validateMigrationEnvironment({ ...staging, MOONLIGHT_MIGRATION_CONFIRM: "yes" }), /confirmation/i);
  assert.throws(() => validateMigrationEnvironment({ ...staging, MIGRATION_DATABASE_URL: connectionUrl("public-proxy.railway.app", 5432, "moonlight", { password: "x" }) }), /private Railway hostname/i);
});

test("command-line execution requires a separate explicit confirmation flag", () => {
  assert.throws(() => requireCliConfirmation([]), /explicit command confirmation/i);
  assert.doesNotThrow(() => requireCliConfirmation(["--confirm-staging-migrations"]));
});
