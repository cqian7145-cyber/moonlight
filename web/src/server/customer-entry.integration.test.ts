import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { getPublicTableEntry, loadCustomerEntryPage } from "./customer-entry";
import { hashToken } from "./tokens";

function createTestDatabase(client: PGlite) {
  return drizzle(client, { schema });
}

type TestDatabase = ReturnType<typeof createTestDatabase>;
let client: PGlite;
let db: TestDatabase;
let now: Date;
const clock = () => new Date(now);
const code = () => randomBytes(32).toString("base64url");
const content = {
  cues: [
    { key: "q1", prompt: "选择一", choices: ["甲", "乙", "丙"] },
    { key: "q2", prompt: "选择二", choices: ["甲", "乙", "丙"] },
    { key: "q3", prompt: "选择三", choices: ["甲", "乙", "丙"] },
  ],
};

async function migrateFresh() {
  client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
}

async function fixture(options: {
  venueStatus?: "active" | "suspended" | "archived";
  tableEnabled?: boolean;
  publicationStatus?: "active" | "inactive";
  activatedAt?: Date;
  venueName?: string;
} = {}) {
  const tableCode = code();
  const [venue] = await db.insert(schema.venues).values({ name: options.venueName ?? "月光小馆", status: options.venueStatus ?? "active" }).returning();
  const [table] = await db.insert(schema.venueTables).values({
    venueId: venue.id, name: "靠窗 3 号桌", publicCodeHash: hashToken(tableCode), isEnabled: options.tableEnabled ?? true,
  }).returning();
  const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue.id, title: "今晚的微醺灵感" }).returning();
  const [version] = await db.insert(schema.activityVersions).values({ venueId: venue.id, templateId: template.id, versionNo: 1, content }).returning();
  const activatedAt = options.activatedAt ?? new Date(now.getTime() - 60_000);
  const [publication] = await db.insert(schema.publications).values({
    venueId: venue.id, versionId: version.id, status: options.publicationStatus ?? "active", activatedAt,
    deactivatedAt: options.publicationStatus === "inactive" ? now : null,
  }).returning();
  return { tableCode, venue, table, template, version, publication };
}

beforeEach(async () => {
  now = new Date("2026-10-26T13:00:00.000Z");
  await migrateFresh();
});

afterEach(async () => client.close());

describe("public customer table entry backed by the checked-in SQL migration", () => {
  it("returns only the venue label, active activity title, and question count for a valid QR code", async () => {
    const seeded = await fixture();
    await expect(getPublicTableEntry(db, seeded.tableCode, { clock })).resolves.toEqual({
      status: "ready", venueName: "月光小馆", activityTitle: "今晚的微醺灵感", questionCount: 3,
    });
  });

  it("rejects unknown, malformed, too-short, and oversized table codes without leaking database detail", async () => {
    const seeded = await fixture();
    for (const invalid of ["missing-table-code-123456789", "short", "bad/%2f-code".repeat(3), "x".repeat(129)]) {
      await expect(getPublicTableEntry(db, invalid, { clock })).resolves.toEqual({ status: "not_found" });
    }
    await expect(getPublicTableEntry(db, code(), { clock })).resolves.toEqual({ status: "not_found" });
    let databaseOpened = false;
    await expect(loadCustomerEntryPage("short", () => { databaseOpened = true; return db; }, { clock }))
      .resolves.toEqual({ status: "not_found" });
    expect(databaseOpened).toBe(false);
    expect(seeded.table.id).toBeTruthy();
  });

  it("never falls back to another venue's active publication", async () => {
    const tableWithoutActivity = await fixture();
    const otherVenue = await fixture({ venueName: "另一家门店" });
    await db.update(schema.publications).set({ status: "inactive", deactivatedAt: now })
      .where(eq(schema.publications.id, tableWithoutActivity.publication.id));
    await expect(getPublicTableEntry(db, tableWithoutActivity.tableCode, { clock }))
      .resolves.toEqual({ status: "no_activity" });
    await expect(getPublicTableEntry(db, otherVenue.tableCode, { clock }))
      .resolves.toMatchObject({ status: "ready", venueName: "另一家门店", activityTitle: "今晚的微醺灵感" });
  });

  it("refuses disabled tables and suspended or archived venues", async () => {
    const disabledTable = await fixture({ tableEnabled: false });
    await expect(getPublicTableEntry(db, disabledTable.tableCode, { clock })).resolves.toEqual({ status: "table_paused" });
    const suspendedVenue = await fixture({ venueStatus: "suspended" });
    await expect(getPublicTableEntry(db, suspendedVenue.tableCode, { clock })).resolves.toEqual({ status: "venue_paused" });
    const archivedVenue = await fixture({ venueStatus: "archived" });
    await expect(getPublicTableEntry(db, archivedVenue.tableCode, { clock })).resolves.toEqual({ status: "venue_paused" });
  });

  it("returns no-activity for absent, inactive, or not-yet-effective publications", async () => {
    const inactive = await fixture({ publicationStatus: "inactive" });
    await expect(getPublicTableEntry(db, inactive.tableCode, { clock })).resolves.toEqual({ status: "no_activity" });
    const future = await fixture({ activatedAt: new Date(now.getTime() + 60_000) });
    await expect(getPublicTableEntry(db, future.tableCode, { clock })).resolves.toEqual({ status: "no_activity" });
    const absent = await fixture();
    await db.update(schema.publications).set({ status: "inactive", deactivatedAt: now }).where(eq(schema.publications.id, absent.publication.id));
    await expect(getPublicTableEntry(db, absent.tableCode, { clock })).resolves.toEqual({ status: "no_activity" });
  });

  it("uses the current immutable version and does not write attempts or submissions", async () => {
    const seeded = await fixture();
    const entry = await getPublicTableEntry(db, seeded.tableCode, { clock });
    expect(entry).toEqual({ status: "ready", venueName: "月光小馆", activityTitle: "今晚的微醺灵感", questionCount: 3 });
    await expect(db.update(schema.activityVersions).set({ versionNo: 2 }).where(eq(schema.activityVersions.id, seeded.version.id)))
      .rejects.toMatchObject({ cause: { code: "55000" } });
    expect(await db.select().from(schema.attempts)).toHaveLength(0);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
  });

  it("shares the page loader with the database-backed read and degrades safely when the adapter is unavailable", async () => {
    const seeded = await fixture();
    await expect(loadCustomerEntryPage(seeded.tableCode, () => db, { clock })).resolves.toEqual({
      status: "ready", venueName: "月光小馆", activityTitle: "今晚的微醺灵感", questionCount: 3,
    });
    const unavailable = await loadCustomerEntryPage(seeded.tableCode, () => { throw new Error("private connection detail"); }, { clock });
    expect(unavailable).toEqual({ status: "unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("private connection detail");
  });
});
