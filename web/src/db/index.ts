import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type DatabaseGlobal = typeof globalThis & { moonlightPool?: Pool };

export function getDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when the PostgreSQL adapter is used.");
  }

  const databaseGlobal = globalThis as DatabaseGlobal;
  databaseGlobal.moonlightPool ??= new Pool({ connectionString });

  return drizzle({ client: databaseGlobal.moonlightPool, schema });
}
