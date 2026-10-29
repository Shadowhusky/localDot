import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  REPORT_CONTENT_TYPE,
  REPORT_GZIP_MAX,
  REPORT_ID,
  REPORT_TOKEN,
  type ReportBundle,
} from "../../../packages/protocol/src/reports.ts";

const ORIGIN = "https://reports.example.com";
const OWNER = "owner-token-for-tests-0123456789abcdef";
const DAY = 86_400_000;
let mf: Miniflare;

function bundle(overrides: Partial<ReportBundle> = {}): ReportBundle {
  return {
    format: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    installId: "0123456789abcdef0123456789abcdef",
    source: "app",
    summary: "Task ended: the brain kept crashing",
    message: "It stopped halfway through a download.",
    context: {
      kind: "task",
      sessionId: "01M5W3F2P1NMZC9DZ9JP761JXD",
      reason: "the brain kept crashing",
    },
    app: { version: "1.4.0-rc.2", channel: "rc", install: "managed", state: "running" },
    host: {
      os: "darwin",
      arch: "arm64",
      release: "25.6.0",
      node: "v24.11.0",
      cpus: 10,
      memoryGB: 32,
    },
    services: { keyd: "ready", docker: "running" },
    doctor: [{ name: "docker-engine", ok: true, detail: "Docker Engine 29.2.0" }],
    computers: [],
    tasks: [],
    logs: [
      { name: "daemon.log", lines: ["[2026-10-29T08:00:00Z] daemon started"], truncated: false },
    ],
    ...overrides,
  };
}

function send(body: Uint8Array | string, address: string, type = REPORT_CONTENT_TYPE) {
  return mf.dispatchFetch(`${ORIGIN}/v1/reports`, {
    method: "POST",
    headers: { "content-type": type, "cf-connecting-ip": address },
    body,
  });
}
const sendBundle = (value: unknown, address: string) =>
  send(gzipSync(JSON.stringify(value)), address);
const owner = (path: string, init: RequestInit = {}) =>
  mf.dispatchFetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${OWNER}`, ...(init.headers as Record<string, string>) },
  });

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "reports",
          modules: true,
          scriptPath: "dist/worker.js",
          compatibilityDate: "2026-10-10",
          bindings: { OWNER_TOKEN: OWNER },
          d1Databases: { DB: "reports-db" },
          kvNamespaces: { BUNDLES: "reports-kv" },
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const sql = readFileSync(new URL("../migrations/0001_reports.sql", import.meta.url), "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await db.batch(sql.map((statement) => db.prepare(statement)));
});
after(() => mf?.dispose());

test("a sent report is stored, and its sender can see and delete it", async () => {
  const sent = await sendBundle(bundle(), "203.0.113.1");
  assert.equal(sent.status, 201);
  const receipt = (await sent.json()) as { id: string; token: string };
  assert.match(receipt.id, REPORT_ID);
  assert.match(receipt.token, REPORT_TOKEN);

  const db = await mf.getD1Database("DB");
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?1").bind(receipt.id).first();
  assert.equal(row?.status, "new");
  assert.equal(row?.platform, "darwin arm64");
  assert.equal(row?.description, "It stopped halfway through a download.");
  assert.notEqual(row?.reporter_hash, receipt.token);
  const kv = await mf.getKVNamespace("BUNDLES");
  assert.ok(await kv.get(`bundle:${receipt.id}`, "arrayBuffer"));

  const mine = { authorization: `Bearer ${receipt.token}` };
  const seen = await mf.dispatchFetch(`${ORIGIN}/v1/reports/${receipt.id}`, { headers: mine });
  assert.equal(seen.status, 200);
  const state = (await seen.json()) as Record<string, unknown>;
  assert.equal(state.status, "new");
  assert.equal(state.notes, undefined);

  const other = await sendBundle(bundle({ installId: "f".repeat(32) }), "203.0.113.1");
  const otherToken = ((await other.json()) as { token: string }).token;
  const wrong = await mf.dispatchFetch(`${ORIGIN}/v1/reports/${receipt.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(wrong.status, 404);
  const deleted = await mf.dispatchFetch(`${ORIGIN}/v1/reports/${receipt.id}`, {
    method: "DELETE",
    headers: mine,
  });
  assert.equal(deleted.status, 204);
  assert.equal(await kv.get(`bundle:${receipt.id}`), null);
  const gone = await mf.dispatchFetch(`${ORIGIN}/v1/reports/${receipt.id}`, { headers: mine });
  assert.equal(gone.status, 404);
});

test("only well-formed reports within the size limits are accepted", async () => {
  const address = "203.0.113.2";
  const untyped = await mf.dispatchFetch(`${ORIGIN}/v1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
  });
  assert.equal(untyped.status, 415);
  // Streamed without a length, so the limit is found while reading.
  const oversized = await mf.dispatchFetch(`${ORIGIN}/v1/reports`, {
    method: "POST",
    headers: { "content-type": REPORT_CONTENT_TYPE, "cf-connecting-ip": address },
    body: new Blob([new Uint8Array(REPORT_GZIP_MAX + 1)]).stream(),
    duplex: "half",
  });
  assert.equal(oversized.status, 413);
  // A small gzip that inflates past the limit is refused while inflating.
  assert.equal((await send(gzipSync(Buffer.alloc(8 * 1024 * 1024, 32)), address)).status, 413);
  assert.equal((await send("not gzip", address)).status, 400);
  assert.equal((await send(gzipSync("{"), address)).status, 400);
  assert.equal((await sendBundle({ ...bundle(), extra: true }, address)).status, 400);
  assert.equal((await sendBundle(bundle({ summary: "" }), address)).status, 400);
  assert.equal((await sendBundle(bundle({ installId: "not-an-id" }), address)).status, 400);
  assert.equal(
    (await mf.dispatchFetch(`http://reports.example.com/v1/reports`, { method: "POST" })).status,
    400,
  );
});

test("reports are limited per installation and per address", async () => {
  const install = "1".repeat(32);
  for (let i = 0; i < 6; i++)
    assert.equal((await sendBundle(bundle({ installId: install }), "203.0.113.3")).status, 201);
  const refused = await sendBundle(bundle({ installId: install }), "203.0.113.3");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "3600");
  assert.match(await refused.text(), /from this computer/);

  for (let i = 0; i < 20; i++) await send("not gzip", "203.0.113.4");
  const flooded = await sendBundle(bundle({ installId: "2".repeat(32) }), "203.0.113.4");
  assert.equal(flooded.status, 429);
  assert.match(await flooded.text(), /from this network/);
});

test("the owner lists, searches, reads, tracks and deletes reports", async () => {
  assert.equal((await mf.dispatchFetch(`${ORIGIN}/v1/owner/reports`)).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch(`${ORIGIN}/v1/owner/reports`, {
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  const sent = await sendBundle(
    bundle({
      installId: "3".repeat(32),
      summary: "Web browser failed to start",
      message: "Blank page",
    }),
    "203.0.113.5",
  );
  const { id } = (await sent.json()) as { id: string };

  const listed = (await (await owner("/v1/owner/reports?q=browser failed")).json()) as {
    reports: { id: string; summary: string; status: string }[];
    counts: Record<string, number>;
  };
  assert.deepEqual(
    listed.reports.map((r) => r.id),
    [id],
  );
  assert.ok((listed.counts.new ?? 0) >= 1);
  assert.equal((await owner("/v1/owner/reports?status=unknown")).status, 400);
  // LIKE wildcards in a search are matched literally.
  const literal = (await (await owner("/v1/owner/reports?q=%25")).json()) as { reports: [] };
  assert.equal(literal.reports.length, 0);

  const detail = (await (await owner(`/v1/owner/reports/${id}`)).json()) as Record<string, unknown>;
  assert.equal(detail.description, "Blank page");
  assert.equal(detail.installId, "3".repeat(32));
  const raw = await owner(`/v1/owner/reports/${id}/bundle`);
  assert.equal(raw.status, 200);
  assert.equal(((await raw.json()) as ReportBundle).summary, "Web browser failed to start");

  const changed = await owner(`/v1/owner/reports/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "investigating", notes: "Chromium exits at launch on 25.6" }),
  });
  assert.equal(changed.status, 200);
  assert.equal(((await changed.json()) as { status: string }).status, "investigating");
  const filtered = (await (await owner("/v1/owner/reports?status=investigating")).json()) as {
    reports: { id: string; notes: string }[];
  };
  assert.deepEqual(
    filtered.reports.map((r) => [r.id, r.notes]),
    [[id, "Chromium exits at launch on 25.6"]],
  );
  const invalid = await owner(`/v1/owner/reports/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "closed" }),
  });
  assert.equal(invalid.status, 400);

  assert.equal((await owner(`/v1/owner/reports/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await owner(`/v1/owner/reports/${id}`)).status, 404);
  assert.equal((await owner(`/v1/owner/reports/${id}/bundle`)).status, 404);
});

test("the owner pages through reports received the same millisecond", async () => {
  const db = await mf.getD1Database("DB");
  const at = Date.now() - 1000;
  await db.batch(
    Array.from({ length: 55 }, (_, i) =>
      db
        .prepare(
          "INSERT INTO reports (id, received_at, updated_at, install_id, version, channel, platform, source, summary, bundle_bytes, reporter_hash) VALUES (?1, ?2, ?2, ?3, '1.0.0', 'stable', 'linux x64', 'cli', 'paged', 10, 'x')",
        )
        .bind(`LD-PAGE-${String(i).padStart(2, "0")}AA`, at, "4".repeat(32)),
    ),
  );
  const first = (await (await owner("/v1/owner/reports?q=paged")).json()) as {
    reports: { id: string }[];
    next: string;
  };
  assert.equal(first.reports.length, 50);
  const second = (await (
    await owner(`/v1/owner/reports?q=paged&before=${encodeURIComponent(first.next)}`)
  ).json()) as { reports: { id: string }[]; next: string | null };
  assert.equal(second.reports.length, 5);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.reports, ...second.reports].map((r) => r.id)).size, 55);
});

test("the owner page is served locked down, without any data", async () => {
  const page = await mf.dispatchFetch(`${ORIGIN}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await page.text();
  assert.match(html, /localDot reports/);
  assert.doesNotMatch(html, new RegExp(OWNER));
  assert.equal(
    (await mf.dispatchFetch(`${ORIGIN}/owner.js`)).headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal((await mf.dispatchFetch(`${ORIGIN}/elsewhere`)).status, 404);
});

test("the daily sweep removes reports past retention and spent counters", async () => {
  const db = await mf.getD1Database("DB");
  const old = Date.now() - 181 * DAY;
  await db.batch([
    db
      .prepare(
        "INSERT INTO reports (id, received_at, updated_at, install_id, version, channel, platform, source, summary, bundle_bytes, reporter_hash) VALUES ('LD-OLD0-0000', ?1, ?1, ?2, '1.0.0', 'stable', 'linux x64', 'cli', 'old', 10, 'x')",
      )
      .bind(old, "5".repeat(32)),
    db
      .prepare("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ('spent', 3, ?1)")
      .bind(old),
  ]);
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "17 3 * * *" });
  assert.equal(await db.prepare("SELECT id FROM reports WHERE id = 'LD-OLD0-0000'").first(), null);
  assert.equal(
    await db.prepare("SELECT bucket FROM rate_limits WHERE bucket = 'spent'").first(),
    null,
  );
  assert.ok(await db.prepare("SELECT id FROM reports WHERE summary = 'paged'").first());
});
