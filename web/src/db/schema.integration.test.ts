import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";

function createTestDatabase(client: PGlite) {
  return drizzle(client, { schema });
}

type TestDatabase = ReturnType<typeof createTestDatabase>;

let client: PGlite;
let db: TestDatabase;

async function runMigrations() {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
}

async function createVenue(name: string) {
  const [venue] = await db.insert(schema.venues).values({ name, timezone: "Asia/Shanghai" }).returning();
  return venue;
}

async function createTemplate(venueId: string, title = "今晚小签") {
  const [template] = await db.insert(schema.activityTemplates).values({ venueId, title }).returning();
  return template;
}

async function createVersion(venueId: string, templateId: string, versionNo = 1) {
  const [version] = await db.insert(schema.activityVersions).values({
    venueId,
    templateId,
    versionNo,
    content: { cues: [{ key: "first", prompt: "选一个", choices: ["A", "B"] }] },
  }).returning();
  return version;
}

async function createPublication(venueId: string, versionId: string, status: "active" | "inactive" = "active") {
  const activatedAt = new Date();
  const [publication] = await db.insert(schema.publications).values({
    venueId,
    versionId,
    status,
    activatedAt,
    deactivatedAt: status === "inactive" ? activatedAt : null,
  }).returning();
  return publication;
}

async function createPlayGroup(venueId: string, publicationId: string, tableId: string | null = null) {
  const [group] = await db.insert(schema.playGroups).values({
    venueId,
    publicationId,
    tableId,
    inviteCodeHash: `invite-hash-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  }).returning();
  return group;
}

async function createAttempt(publicationId: string, options: {
  mode?: "solo" | "duo";
  playGroupId?: string | null;
  consentedAt?: Date | null;
} = {}) {
  const [attempt] = await db.insert(schema.attempts).values({
    publicationId,
    mode: options.mode ?? "solo",
    playGroupId: options.playGroupId ?? null,
    consentedAt: options.consentedAt ?? null,
    sessionTokenHash: `session-hash-${crypto.randomUUID()}`,
  }).returning();
  return attempt;
}

describe("PostgreSQL schema migrations and constraints", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = createTestDatabase(client);
    await runMigrations();
  });

  afterEach(async () => {
    await client.close();
  });

  it("runs the checked-in migration from empty state and safely reruns it", async () => {
    const venue = await createVenue("Migration smoke test");

    await runMigrations();

    const rows = await db.select({ id: schema.venues.id }).from(schema.venues);
    expect(rows).toEqual([{ id: venue.id }]);
  });

  it("rejects duplicate versions for one template", async () => {
    const venue = await createVenue("Version uniqueness");
    const template = await createTemplate(venue.id);
    await createVersion(venue.id, template.id, 1);

    await expect(createVersion(venue.id, template.id, 1)).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects updates and deletes of an immutable activity version", async () => {
    const venue = await createVenue("Immutable version");
    const template = await createTemplate(venue.id);
    const version = await createVersion(venue.id, template.id);

    await expect(db.update(schema.activityVersions).set({ versionNo: 2 }).where(
      eq(schema.activityVersions.id, version.id),
    )).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(db.delete(schema.activityVersions).where(
      eq(schema.activityVersions.id, version.id),
    )).rejects.toMatchObject({ cause: { code: "55000" } });
  });

  it("rejects duplicate cue submissions for the same attempt", async () => {
    const venue = await createVenue("Submission uniqueness");
    const template = await createTemplate(venue.id);
    const version = await createVersion(venue.id, template.id);
    const publication = await createPublication(venue.id, version.id);
    const attempt = await createAttempt(publication.id);
    const submission = { attemptId: attempt.id, cueKey: "first", answer: { choice: "A" } };
    await db.insert(schema.submissions).values(submission);

    await expect(db.insert(schema.submissions).values(submission)).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects missing venue, publication, and attempt foreign keys", async () => {
    await expect(db.insert(schema.venueTables).values({
      venueId: crypto.randomUUID(), name: "桌 1", publicCodeHash: "public-code-hash-1",
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    await expect(db.insert(schema.attempts).values({
      publicationId: crypto.randomUUID(), sessionTokenHash: "session-hash-missing-publication",
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    await expect(db.insert(schema.submissions).values({
      attemptId: crypto.randomUUID(), cueKey: "first", answer: { choice: "A" },
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("keeps public table codes unique without treating them as venue credentials", async () => {
    const venue = await createVenue("Public table codes");
    await db.insert(schema.venueTables).values({ venueId: venue.id, name: "桌 1", publicCodeHash: "same-public-code-hash" });

    await expect(db.insert(schema.venueTables).values({
      venueId: venue.id, name: "桌 2", publicCodeHash: "same-public-code-hash",
    })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("allows at most one active publication per venue while retaining inactive history", async () => {
    const venue = await createVenue("Publication limit");
    const template = await createTemplate(venue.id);
    const versionOne = await createVersion(venue.id, template.id, 1);
    const versionTwo = await createVersion(venue.id, template.id, 2);
    await createPublication(venue.id, versionOne.id, "active");
    await createPublication(venue.id, versionOne.id, "inactive");

    await expect(createPublication(venue.id, versionTwo.id, "active")).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("prevents a publication from referencing another venue's version", async () => {
    const venueA = await createVenue("Venue A");
    const venueB = await createVenue("Venue B");
    const templateB = await createTemplate(venueB.id);
    const versionB = await createVersion(venueB.id, templateB.id);

    await expect(createPublication(venueA.id, versionB.id)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("prevents a group from linking a table from another venue", async () => {
    const venueA = await createVenue("Group venue A");
    const venueB = await createVenue("Group venue B");
    const template = await createTemplate(venueA.id);
    const version = await createVersion(venueA.id, template.id);
    const publication = await createPublication(venueA.id, version.id);
    const [tableB] = await db.insert(schema.venueTables).values({
      venueId: venueB.id, name: "桌 9", publicCodeHash: "table-b-code-hash",
    }).returning();

    await expect(createPlayGroup(venueA.id, publication.id, tableB.id)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("requires a group and explicit participant consent for duo attempts", async () => {
    const venue = await createVenue("Duo consent");
    const template = await createTemplate(venue.id);
    const version = await createVersion(venue.id, template.id);
    const publication = await createPublication(venue.id, version.id);
    const group = await createPlayGroup(venue.id, publication.id);

    await expect(createAttempt(publication.id, { mode: "duo", playGroupId: group.id })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(createAttempt(publication.id, { mode: "duo", consentedAt: new Date() })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(createAttempt(publication.id, {
      mode: "duo", playGroupId: group.id, consentedAt: new Date(),
    })).resolves.toMatchObject({ playGroupId: group.id, mode: "duo" });
  });

  it("prevents a duo attempt from joining a group for another publication", async () => {
    const venue = await createVenue("Group publication match");
    const template = await createTemplate(venue.id);
    const versionOne = await createVersion(venue.id, template.id, 1);
    const versionTwo = await createVersion(venue.id, template.id, 2);
    const publicationOne = await createPublication(venue.id, versionOne.id);
    const publicationTwo = await createPublication(venue.id, versionTwo.id, "inactive");
    const group = await createPlayGroup(venue.id, publicationOne.id);

    await expect(createAttempt(publicationTwo.id, {
      mode: "duo", playGroupId: group.id, consentedAt: new Date(),
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("accepts only a non-empty cue array in a version snapshot", async () => {
    const venue = await createVenue("Question snapshot");
    const template = await createTemplate(venue.id);

    await expect(db.insert(schema.activityVersions).values({
      venueId: venue.id, templateId: template.id, versionNo: 1, content: { cues: [] },
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects malformed question cues before they become an immutable snapshot", async () => {
    const venue = await createVenue("Malformed cues");
    const template = await createTemplate(venue.id);

    await expect(db.insert(schema.activityVersions).values({
      venueId: venue.id,
      templateId: template.id,
      versionNo: 1,
      content: { cues: [{ key: "first", choices: ["A", "B"] }] } as unknown as schema.ActivityContent,
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects duplicate cue keys inside one version snapshot", async () => {
    const venue = await createVenue("Duplicate cue keys");
    const template = await createTemplate(venue.id);

    await expect(db.insert(schema.activityVersions).values({
      venueId: venue.id,
      templateId: template.id,
      versionNo: 1,
      content: { cues: [
        { key: "first", prompt: "选一个", choices: ["A", "B"] },
        { key: "first", prompt: "再选一个", choices: ["C", "D"] },
      ] },
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("allows at most one feedback row per attempt", async () => {
    const venue = await createVenue("Feedback uniqueness");
    const template = await createTemplate(venue.id);
    const version = await createVersion(venue.id, template.id);
    const publication = await createPublication(venue.id, version.id);
    const attempt = await createAttempt(publication.id);
    await db.insert(schema.feedback).values({ attemptId: attempt.id, rating: 5 });

    await expect(db.insert(schema.feedback).values({ attemptId: attempt.id, rating: 4 })).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
