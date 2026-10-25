import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localEnvPath = resolve(root, "web/.env.local");
const fixturePath = resolve(root, ".local/m007b-fixture.json");
const connectionString = process.env.DATABASE_URL ?? (await readFile(localEnvPath, "utf8"))
  .split(/\r?\n/)
  .find((line) => line.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length);

if (!connectionString) throw new Error("DATABASE_URL is required for the local M-007B fixture.");
const databaseUrl = new URL(connectionString);
if (!new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(databaseUrl.hostname.toLowerCase())) {
  throw new Error("The M-007B fixture refuses non-loopback database hosts.");
}
if (databaseUrl.pathname !== "/moonlight_dev") {
  throw new Error("The M-007B fixture only writes to the moonlight_dev database.");
}

const ids = {
  mainVenue: "a7000000-0000-4000-8000-000000000001",
  pausedVenue: "a7000000-0000-4000-8000-000000000002",
  emptyVenue: "a7000000-0000-4000-8000-000000000003",
  mainTable: "a7000000-0000-4000-8000-000000000011",
  pausedTable: "a7000000-0000-4000-8000-000000000012",
  emptyTable: "a7000000-0000-4000-8000-000000000013",
  disabledTable: "a7000000-0000-4000-8000-000000000014",
  template: "a7000000-0000-4000-8000-000000000021",
  version: "a7000000-0000-4000-8000-000000000031",
  publication: "a7000000-0000-4000-8000-000000000041",
};

async function loadFixtureCodes() {
  try {
    const saved = JSON.parse(await readFile(fixturePath, "utf8"));
    if (!saved || typeof saved !== "object" || !["main", "pausedVenue", "noActivity", "disabledTable"].every((key) =>
      typeof saved[key] === "string" && /^[A-Za-z0-9_-]{43}$/.test(saved[key]))) {
      throw new Error("Invalid M-007B fixture-code file.");
    }
    return saved;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    const codes = Object.fromEntries(["main", "pausedVenue", "noActivity", "disabledTable"]
      .map((key) => [key, randomBytes(32).toString("base64url")]));
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(codes, null, 2)}\n`, { flag: "wx" });
    return codes;
  }
}

const codes = await loadFixtureCodes();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
});
const content = {
  cues: [
    { key: "m007b-q1", prompt: "今晚想要哪种节奏？", choices: ["慢慢聊", "听点音乐", "换个新口味"] },
    { key: "m007b-q2", prompt: "更喜欢哪种小惊喜？", choices: ["轻松", "有趣", "安静"] },
    { key: "m007b-q3", prompt: "给今晚留一点什么？", choices: ["空白", "灵感", "笑声"] },
  ],
};

const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
const ensure = async (label, selectSql, insertSql, values, verify) => {
  let result = await client.query(selectSql, [values[0]]);
  if (result.rowCount === 0) {
    await client.query(insertSql, values);
    result = await client.query(selectSql, [values[0]]);
  }
  if (result.rowCount !== 1 || !verify(result.rows[0])) {
    throw new Error(`M-007B fixture key collision at ${label}; existing data was not changed.`);
  }
};

try {
  await client.query("BEGIN");
  await ensure("active venue", "SELECT id, name, status FROM venues WHERE id=$1", "INSERT INTO venues(id,name,status) VALUES($1,$2,'active')", [ids.mainVenue, "月光测试小馆 M007B"], (row) => row.name === "月光测试小馆 M007B" && row.status === "active");
  await ensure("paused venue", "SELECT id, name, status FROM venues WHERE id=$1", "INSERT INTO venues(id,name,status) VALUES($1,$2,'suspended')", [ids.pausedVenue, "虚构暂停门店 M007B"], (row) => row.name === "虚构暂停门店 M007B" && row.status === "suspended");
  await ensure("no-activity venue", "SELECT id, name, status FROM venues WHERE id=$1", "INSERT INTO venues(id,name,status) VALUES($1,$2,'active')", [ids.emptyVenue, "虚构无上架活动门店 M007B"], (row) => row.name === "虚构无上架活动门店 M007B" && row.status === "active");

  const table = async (label, id, venueId, name, code, enabled) => ensure(
    label,
    "SELECT id, venue_id, name, public_code_hash, is_enabled FROM venue_tables WHERE id=$1",
    "INSERT INTO venue_tables(id,venue_id,name,public_code_hash,is_enabled) VALUES($1,$2,$3,$4,$5)",
    [id, venueId, name, sha256(code), enabled],
    (row) => row.venue_id === venueId && row.name === name && row.public_code_hash === sha256(code) && row.is_enabled === enabled,
  );
  await table("active table", ids.mainTable, ids.mainVenue, "虚构测试桌 01", codes.main, true);
  await table("disabled table", ids.disabledTable, ids.mainVenue, "虚构停用桌 02", codes.disabledTable, false);
  await table("paused-venue table", ids.pausedTable, ids.pausedVenue, "虚构暂停桌", codes.pausedVenue, true);
  await table("no-activity table", ids.emptyTable, ids.emptyVenue, "虚构无活动桌", codes.noActivity, true);

  await ensure("activity template", "SELECT id, venue_id, title FROM activity_templates WHERE id=$1", "INSERT INTO activity_templates(id,venue_id,title) VALUES($1,$2,$3)", [ids.template, ids.mainVenue, "M-007B 虚构三题题包"], (row) => row.venue_id === ids.mainVenue && row.title === "M-007B 虚构三题题包");
  await ensure("immutable activity version", "SELECT id, venue_id, template_id, version_no, content FROM activity_versions WHERE id=$1", "INSERT INTO activity_versions(id,venue_id,template_id,version_no,content) VALUES($1,$2,$3,1,$4::jsonb)", [ids.version, ids.mainVenue, ids.template, JSON.stringify(content)], (row) => row.venue_id === ids.mainVenue && row.template_id === ids.template && row.version_no === 1 && canonicalJson(row.content) === canonicalJson(content));
  await ensure("active publication", "SELECT id, venue_id, version_id, status, deactivated_at FROM publications WHERE id=$1", "INSERT INTO publications(id,venue_id,version_id,status) VALUES($1,$2,$3,'active')", [ids.publication, ids.mainVenue, ids.version], (row) => row.venue_id === ids.mainVenue && row.version_id === ids.version && row.status === "active" && row.deactivated_at === null);

  await client.query("COMMIT");
  console.log("M-007B fictional fixtures verified; no existing row was updated or deleted.");
  console.log(`entry=http://localhost:3010/t/${codes.main}`);
  console.log(`invalidTestCodes=${Object.keys(codes).length - 1} (fake fixtures only)`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
