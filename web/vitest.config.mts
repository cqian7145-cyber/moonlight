import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "server-only": resolve(process.cwd(), "src/server/server-only-test.ts") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
