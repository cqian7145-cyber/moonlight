import { defineConfig } from "drizzle-kit";

function getLoopbackDatabaseUrl() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Set DATABASE_URL to an explicitly provisioned local PostgreSQL instance.");
  }

  let hostname: string;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    hostname = url.hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL for a loopback host.");
  }

  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname)) {
    throw new Error("db:migrate:local only accepts localhost, 127.0.0.1, or ::1.");
  }

  return connectionString;
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: getLoopbackDatabaseUrl() },
});
