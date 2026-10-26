import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "server-only": resolve(process.cwd(), "src/server/server-only-test.ts") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // PGlite applies all checked-in migrations in many integration-test hooks.
    // Under parallel Windows workers, 10s is too short for cold startup.
    hookTimeout: 30_000,
  },
});
