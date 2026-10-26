import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { createMerchantAuth } from "../lib/merchant-auth";
import { createMerchantOperationsHandlers } from "./merchant-operations";
import { getSoloQuestions, submitAnswer } from "./attempts";
import { getCurrentActivity } from "./activities";
import { hashToken } from "./tokens";

const origin = "http://localhost:3000";
const secret = "test-secret-with-at-least-thirty-two-characters";
let client: PGlite;
let db: ReturnType<typeof drizzle>;

function request(path: string, method = "GET", body?: unknown, options: { cookie?: string; origin?: string | null; host?: string } = {}) {
  const headers = new Headers({ host: options.host ?? "localhost:3000" });
  if (options.origin !== null) headers.set("origin", options.origin ?? origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function account(emailPrefix: string, role: "owner" | "staff" | "none", venueId?: string) {
  const auth = createMerchantAuth(db as never, { baseURL: origin, secret, allowProvisioning: true });
  const email = `${emailPrefix}-${crypto.randomUUID()}@example.test`;
  const password = `Valid-${crypto.randomUUID()}-A9!`;
  const created = await auth.api.signUpEmail({ body: { name: "虚构运营账号", email, password } });
  if (role !== "none" && venueId) await db.insert(schema.venueMembers).values({ venueId, userId: created.user.id, role });
  const publicAuth = createMerchantAuth(db as never, { baseURL: origin, secret });
  const signedIn = await publicAuth.handler(request("/api/auth/sign-in/email", "POST", { email, password }));
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  return { auth: publicAuth, cookie, userId: created.user.id };
}

type ApiBody = {
  template?: { id: string; title: string; status: "draft" | "archived"; draftContent: schema.ActivityDraftContent | null };
  publication?: { id: string; versionId: string; activatedAt: string };
  versionNo?: number;
  table?: { id: string; venueId: string; name: string; isEnabled: boolean; createdAt: string };
  tableCode?: string;
  printUrl?: string;
  status?: string;
  tables?: { id: string; name: string; isEnabled: boolean }[];
  notice?: string;
};

async function json(response: Response): Promise<ApiBody> {
  return response.json() as Promise<ApiBody>;
}

describe("merchant activity publishing and table management", () => {
  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  });

  afterEach(async () => client.close());

  it("persists editable 3x3 drafts, publishes immutable snapshots, and keeps old attempts on their original version", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "虚构运营门店甲" }).returning();
    const [otherVenue] = await db.insert(schema.venues).values({ name: "虚构运营门店乙" }).returning();
    const owner = await account("owner", "owner", venue!.id);
    const staff = await account("staff", "staff", venue!.id);
    const outsider = await account("outsider", "owner", otherVenue!.id);
    const handlers = createMerchantOperationsHandlers(db as never, owner.auth, { publicOrigin: origin });

    const initial = {
      title: "月光初体验",
      cues: [
        { prompt: "今晚想先聊什么？", choices: ["音乐", "旅行", "食物"] },
        { prompt: "更喜欢怎样的周末？", choices: ["散步", "看展", "宅家"] },
        { prompt: "想带走什么心情？", choices: ["轻松", "好奇", "快乐"] },
      ],
    };
    const created = await handlers.createDraft(request(`/api/merchant/venues/${venue!.id}/activities`, "POST", initial, { cookie: owner.cookie }), venue!.id);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
    const createdBody = await json(created);
    const templateId = String(createdBody.template?.id);
    expect(createdBody.template).toMatchObject({ title: initial.title, status: "draft", draftContent: { title: initial.title, cues: initial.cues } });

    const reread = await handlers.draft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "GET", undefined, { cookie: owner.cookie }), venue!.id, templateId);
    expect((await json(reread)).template).toMatchObject({ draftContent: { title: initial.title, cues: initial.cues } });

    const malformed = await handlers.updateDraft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "PATCH", {
      ...initial, cues: [{ prompt: "坏题", choices: ["只有两个", "选项"] }, ...initial.cues.slice(1)],
    }, { cookie: owner.cookie }), venue!.id, templateId);
    expect(malformed.status).toBe(400);
    const crossOrigin = await handlers.updateDraft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "PATCH", initial, {
      cookie: owner.cookie, origin: "https://attacker.example",
    }), venue!.id, templateId);
    expect(crossOrigin.status).toBe(403);
    const badHost = await handlers.updateDraft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "PATCH", initial, {
      cookie: owner.cookie, host: "attacker.example",
    }), venue!.id, templateId);
    expect(badHost.status).toBe(403);

    const staffWrite = await handlers.createDraft(request(`/api/merchant/venues/${venue!.id}/activities`, "POST", initial, { cookie: staff.cookie }), venue!.id);
    expect(staffWrite.status).toBe(403);
    const staffUpdate = await handlers.updateDraft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "PATCH", initial, { cookie: staff.cookie }), venue!.id, templateId);
    expect(staffUpdate.status).toBe(403);
    const staffPublish = await handlers.publish(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", {
      expectedCurrentPublicationId: null,
    }, { cookie: staff.cookie }), venue!.id, templateId);
    expect(staffPublish.status).toBe(403);
    const crossVenueWrite = await handlers.createDraft(request(`/api/merchant/venues/${venue!.id}/activities`, "POST", initial, { cookie: outsider.cookie }), venue!.id);
    expect(crossVenueWrite.status).toBe(403);
    const noSession = await handlers.createDraft(request(`/api/merchant/venues/${venue!.id}/activities`, "POST", initial), venue!.id);
    expect(noSession.status).toBe(401);
    const staffDraftRead = await handlers.draft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "GET", undefined, { cookie: staff.cookie }), venue!.id, templateId);
    expect(staffDraftRead.status).toBe(403);
    const otherStoreRead = await handlers.draft(request(`/api/merchant/venues/${otherVenue!.id}/activities/${templateId}`, "GET", undefined, { cookie: owner.cookie }), otherVenue!.id, templateId);
    expect(otherStoreRead.status).toBe(403);

    const publishedOne = await handlers.publish(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", {
      expectedCurrentPublicationId: null,
    }, { cookie: owner.cookie }), venue!.id, templateId);
    expect(publishedOne.status).toBe(201);
    const publicationOne = (await json(publishedOne)).publication;
    if (!publicationOne) throw new Error("Expected the first publication to be returned.");
    const [versionOne] = await db.select().from(schema.activityVersions).where(eq(schema.activityVersions.id, publicationOne.versionId));
    expect(versionOne?.content).toEqual({ title: initial.title, cues: initial.cues.map((cue: typeof initial.cues[number], index: number) => ({ key: `question-${index + 1}`, ...cue })) });

    const attemptToken = `attempt-${crypto.randomUUID()}`;
    const [attempt] = await db.insert(schema.attempts).values({ publicationId: publicationOne.id, sessionTokenHash: hashToken(attemptToken) }).returning();

    const nextDraft = {
      title: "月光第二版",
      cues: initial.cues.map((cue: typeof initial.cues[number]) => ({ ...cue, prompt: `新版：${cue.prompt}` })),
    };
    const saved = await handlers.updateDraft(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}`, "PATCH", nextDraft, { cookie: owner.cookie }), venue!.id, templateId);
    expect(saved.status).toBe(200);
    const stalePublish = await handlers.publish(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", {
      expectedCurrentPublicationId: null,
    }, { cookie: owner.cookie }), venue!.id, templateId);
    expect(stalePublish.status).toBe(409);

    const publishedTwo = await handlers.publish(request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", {
      expectedCurrentPublicationId: publicationOne.id,
    }, { cookie: owner.cookie }), venue!.id, templateId);
    expect(publishedTwo.status).toBe(201);
    const publicationTwo = (await json(publishedTwo)).publication;
    if (!publicationTwo) throw new Error("Expected the replacement publication to be returned.");
    const [stillVersionOne] = await db.select().from(schema.activityVersions).where(eq(schema.activityVersions.id, publicationOne.versionId));
    const [versionTwo] = await db.select().from(schema.activityVersions).where(eq(schema.activityVersions.id, publicationTwo.versionId));
    expect(stillVersionOne?.content).toEqual(versionOne?.content);
    expect(versionTwo?.versionNo).toBe(2);
    expect((versionTwo?.content as schema.ActivityContent & { title: string }).title).toBe(nextDraft.title);
    expect((await db.select().from(schema.publications).where(eq(schema.publications.status, "active")))).toHaveLength(1);

    const oldQuestions = await getSoloQuestions(db as never, { participantToken: attemptToken });
    expect(oldQuestions.questions[0]?.prompt).toBe(initial.cues[0]?.prompt);
    const oldAnswer = await submitAnswer(db as never, { participantToken: attemptToken, cueKey: "question-1", optionIndex: 0 });
    expect(oldAnswer.status).toBe("in_progress");
    const [storedAttempt] = await db.select({ publicationId: schema.attempts.publicationId }).from(schema.attempts).where(eq(schema.attempts.id, attempt!.id));
    expect(storedAttempt?.publicationId).toBe(publicationOne.id);

    const unpublish = await handlers.unpublish(request(`/api/merchant/venues/${venue!.id}/publication`, "POST", {
      expectedCurrentPublicationId: publicationTwo.id,
    }, { cookie: owner.cookie }), venue!.id);
    expect(unpublish.status).toBe(200);
    expect(await json(unpublish)).toMatchObject({ status: "inactive" });
    expect((await db.select().from(schema.publications).where(eq(schema.publications.status, "active")))).toHaveLength(0);
    expect((await getSoloQuestions(db as never, { participantToken: attemptToken })).questions[0]?.prompt).toBe(initial.cues[0]?.prompt);
    expect((await submitAnswer(db as never, { participantToken: attemptToken, cueKey: "question-2", optionIndex: 1 })).status).toBe("in_progress");

    const summary = await handlers.publication(request(`/api/merchant/venues/${venue!.id}/publication`, "GET", undefined, { cookie: staff.cookie }), venue!.id);
    expect(summary.status).toBe(200);
  });

  it("stores only table-code hashes and returns a trusted-origin QR URL once on create or rotation", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "虚构桌码门店" }).returning();
    const owner = await account("owner", "owner", venue!.id);
    const staff = await account("staff", "staff", venue!.id);
    const handlers = createMerchantOperationsHandlers(db as never, owner.auth, { publicOrigin: origin });
    const [template] = await db.insert(schema.activityTemplates).values({ venueId: venue!.id, title: "验收题包" }).returning();
    const [version] = await db.insert(schema.activityVersions).values({
      venueId: venue!.id, templateId: template!.id, versionNo: 1,
      content: { cues: [1, 2, 3].map((number) => ({ key: `q${number}`, prompt: `题目 ${number}`, choices: ["一", "二", "三"] })) },
    }).returning();
    await db.insert(schema.publications).values({ venueId: venue!.id, versionId: version!.id, status: "active" });

    const created = await handlers.createTable(request(`/api/merchant/venues/${venue!.id}/tables`, "POST", { name: "桌 08" }, { cookie: owner.cookie }), venue!.id);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
    const createBody = await json(created);
    const firstCode = createBody.tableCode;
    if (!firstCode) throw new Error("Expected a one-time code on table creation.");
    const [firstRow] = await db.select().from(schema.venueTables);
    if (!firstRow) throw new Error("Expected the created table row.");
    expect(firstRow?.publicCodeHash).toBe(hashToken(firstCode));
    expect(firstRow?.publicCodeHash).not.toBe(firstCode);
    expect(createBody.printUrl).toBe(`http://localhost:3000/t/${firstCode}`);
    await expect(getCurrentActivity(db as never, { venueId: venue!.id, publicTableCode: firstCode })).resolves.toMatchObject({ tableId: firstRow?.id });
    expect(await json(await handlers.tables(request(`/api/merchant/venues/${venue!.id}/tables`, "GET", undefined, { cookie: owner.cookie }), venue!.id))).not.toHaveProperty("tableCode");

    const rotated = await handlers.rotateTableCode(request(`/api/merchant/venues/${venue!.id}/tables/${firstRow!.id}/rotate`, "POST", { confirm: true }, { cookie: owner.cookie }), venue!.id, firstRow!.id);
    expect(rotated.status).toBe(200);
    const secondCode = (await json(rotated)).tableCode;
    if (!secondCode) throw new Error("Expected a one-time code on rotation.");
    expect(secondCode).not.toBe(firstCode);
    const [updatedRow] = await db.select().from(schema.venueTables).where(eq(schema.venueTables.id, firstRow!.id));
    expect(updatedRow?.publicCodeHash).toBe(hashToken(secondCode));

    const revokedPublicCode = await db.select({ id: schema.venueTables.id }).from(schema.venueTables).where(and(
      eq(schema.venueTables.venueId, venue!.id), eq(schema.venueTables.publicCodeHash, hashToken(firstCode)),
    ));
    expect(revokedPublicCode).toHaveLength(0);
    await expect(getCurrentActivity(db as never, { venueId: venue!.id, publicTableCode: firstCode })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    await expect(getCurrentActivity(db as never, { venueId: venue!.id, publicTableCode: secondCode })).resolves.toMatchObject({ tableId: firstRow?.id });
    const disabled = await handlers.setTableEnabled(request(`/api/merchant/venues/${venue!.id}/tables/${firstRow!.id}`, "PATCH", { enabled: false }, { cookie: owner.cookie }), venue!.id, firstRow!.id);
    expect(disabled.status).toBe(200);
    await expect(getCurrentActivity(db as never, { venueId: venue!.id, publicTableCode: secondCode })).rejects.toMatchObject({ code: "ACTIVITY_UNAVAILABLE" });
    const enabled = await handlers.setTableEnabled(request(`/api/merchant/venues/${venue!.id}/tables/${firstRow!.id}`, "PATCH", { enabled: true }, { cookie: owner.cookie }), venue!.id, firstRow!.id);
    expect(enabled.status).toBe(200);
    const staffRotate = await handlers.rotateTableCode(request(`/api/merchant/venues/${venue!.id}/tables/${firstRow!.id}/rotate`, "POST", { confirm: true }, { cookie: staff.cookie }), venue!.id, firstRow!.id);
    expect(staffRotate.status).toBe(403);
    const staffTables = await json(await handlers.tables(request(`/api/merchant/venues/${venue!.id}/tables`, "GET", undefined, { cookie: staff.cookie }), venue!.id));
    expect(staffTables.tables?.[0]).not.toHaveProperty("tableCode");
  });

  it("serializes simultaneous first publications and rejects the stale publisher", async () => {
    const [venue] = await db.insert(schema.venues).values({ name: "虚构并发上架门店" }).returning();
    const owner = await account("owner", "owner", venue!.id);
    const handlers = createMerchantOperationsHandlers(db as never, owner.auth, { publicOrigin: origin });
    const draftBody = {
      title: "并发上架测试",
      cues: [1, 2, 3].map((number) => ({ prompt: `题目 ${number}`, choices: ["A", "B", "C"] })),
    };
    const drafts = await Promise.all([1, 2].map(() => handlers.createDraft(
      request(`/api/merchant/venues/${venue!.id}/activities`, "POST", draftBody, { cookie: owner.cookie }), venue!.id,
    )));
    const templateIds = await Promise.all(drafts.map(async (response) => (await json(response)).template?.id));
    const [firstTemplateId, secondTemplateId] = templateIds;
    if (!firstTemplateId || !secondTemplateId) throw new Error("Expected both test drafts to be created.");
    const results = await Promise.all([firstTemplateId, secondTemplateId].map((templateId) => handlers.publish(
      request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", { expectedCurrentPublicationId: null }, { cookie: owner.cookie }),
      venue!.id, templateId,
    )));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    let active = await db.select().from(schema.publications).where(eq(schema.publications.status, "active"));
    expect(active).toHaveLength(1);

    const replacementDrafts = await Promise.all([3, 4].map((number) => handlers.createDraft(
      request(`/api/merchant/venues/${venue!.id}/activities`, "POST", { ...draftBody, title: `并发替换题包 ${number}` }, { cookie: owner.cookie }), venue!.id,
    )));
    const replacementIds = await Promise.all(replacementDrafts.map(async (response) => (await json(response)).template?.id));
    const [replacementOne, replacementTwo] = replacementIds;
    if (!replacementOne || !replacementTwo) throw new Error("Expected both replacement drafts to be created.");
    const activePublicationId = active[0]!.id;
    const switchResults = await Promise.all([replacementOne, replacementTwo].map((templateId) => handlers.publish(
      request(`/api/merchant/venues/${venue!.id}/activities/${templateId}/publish`, "POST", { expectedCurrentPublicationId: activePublicationId }, { cookie: owner.cookie }),
      venue!.id, templateId,
    )));
    expect(switchResults.map((result) => result.status).sort()).toEqual([201, 409]);
    active = await db.select().from(schema.publications).where(eq(schema.publications.status, "active"));
    expect(active).toHaveLength(1);
  });
});
