import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { Stats } from "../src/data.ts";

const TOKEN = "test-owner-key-0123456789abcdef0123456789";
const ORIGIN = "https://admin.localdot.dev";
let mf: Miniflare;
let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  mf.dispatchFetch(ORIGIN + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "admin",
          modules: true,
          scriptPath: "dist/worker.js",
          compatibilityDate: "2026-11-04",
          bindings: {
            OWNER_TOKEN: TOKEN,
            GITHUB_INGEST_TOKEN: "import-only-0123456789abcdef0123456789",
          },
          d1Databases: { DB: "stats", REPORTS: "reports" },
        },
        {
          name: "fixture",
          modules: true,
          scriptPath: "dist-fixture/fixture.js",
          compatibilityDate: "2026-11-04",
          d1Databases: { DB: "stats" },
        },
        {
          name: "closed",
          modules: true,
          scriptPath: "dist/worker.js",
          compatibilityDate: "2026-11-04",
          d1Databases: { DB: "stats", REPORTS: "reports" },
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database("DB", "admin");
  await db.exec(
    readFileSync(new URL("../migrations/0001_stats.sql", import.meta.url), "utf8")
      .replace(/--[^\n]*/g, "")
      .replace(/\n/g, " "),
  );
  const reports = await mf.getD1Database("REPORTS", "admin");
  await reports.exec(
    "CREATE TABLE reports (received_at INTEGER, install_id TEXT, status TEXT, version TEXT)",
  );
  await reports
    .prepare("INSERT INTO reports VALUES(?,?,?,?)")
    .bind(Date.now(), "private-install-id", "new", "rc.39")
    .run();
});
after(() => mf?.dispose());
test("anonymous pages, JSON and CSV do not reveal statistics; configuration fails closed", async () => {
  for (const path of ["/stats", "/api/stats", "/api/export"]) {
    const res = await mf.dispatchFetch(ORIGIN + path);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!(await res.text()).includes("private-install-id"));
  }
  const closed = await mf.getWorker("closed");
  assert.equal((await closed.fetch(ORIGIN + "/stats")).status, 503);
});
test("login needs matching origin and creates an expiring HttpOnly session", async () => {
  const init = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({ key: TOKEN }),
  };
  assert.equal(
    (
      await mf.dispatchFetch(ORIGIN + "/login", {
        ...init,
        headers: { ...init.headers, origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const res = await mf.dispatchFetch(ORIGIN + "/login", { ...init, redirect: "manual" });
  assert.equal(res.status, 303);
  const set = res.headers.get("set-cookie");
  assert.ok(set);
  assert.match(set, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(set, /Max-Age=28800/);
  assert.ok(!set.includes(TOKEN));
  cookie = set.split(";")[0];
  assert.equal(
    (await mf.dispatchFetch(ORIGIN + "/api/stats", { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await mf.dispatchFetch(ORIGIN + "/api/stats", { headers: { cookie: cookie + "0" } })).status,
    401,
  );
  assert.equal((await mf.dispatchFetch(ORIGIN + "/api/stats?key=" + TOKEN)).status, 401);
});
test("cross-origin logout and oversized login payloads are refused", async () => {
  for (const path of ["/logout"])
    assert.equal(
      (await api(path, { method: "POST", headers: { origin: "https://evil.example" } })).status,
      403,
    );
  assert.equal(
    (
      await mf.dispatchFetch(ORIGIN + "/login", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: "key=" + "x".repeat(5000),
      })
    ).status,
    413,
  );
});
test("edge collection excludes failures, bots, HEAD, Range, prefetch and privacy opt-outs", async () => {
  const fixture = await mf.getWorker("fixture");
  const headers = { "user-agent": "Mozilla/5.0 Macintosh", accept: "text/html" };
  for (const extra of [
    { dnt: "1" },
    { "sec-gpc": "1" },
    { range: "bytes=0-1" },
    { purpose: "prefetch" },
    { "user-agent": "Googlebot" },
  ])
    await fixture.fetch("https://fixture/counter?event=page", {
      headers: { ...headers, ...extra },
    });
  await fixture.fetch("https://fixture/counter?event=page&status=404", { headers });
  await fixture.fetch("https://fixture/counter?event=page", { method: "HEAD", headers });
  let data = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(data.current.page, undefined);
  await fixture.fetch("https://fixture/counter?event=page&utm_source=github&token=SECRET", {
    headers: {
      ...headers,
      referer: "https://example.com/private?key=SECRET",
      "cf-connecting-ip": "192.0.2.1",
    },
  });
  await fixture.fetch("https://fixture/counter", { headers: { "user-agent": "curl/8.0" } });
  data = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(data.current.page, 1);
  assert.equal(data.current.installer_shell, 1);
  assert.equal(data.sources[0].label, "github");
  assert.equal(data.platforms[0].label, "macOS");
  const db = await mf.getD1Database("DB", "admin");
  const rows = await db.prepare("SELECT * FROM counters").all();
  assert.ok(!JSON.stringify(rows).match(/SECRET|192\.0\.2\.1|private|Mozilla/));
});
test("GitHub history is a baseline, deltas are idempotent, errors retain last good counts", async () => {
  const fixture = await mf.getWorker("fixture");
  const sync = (count: number, status = 200) =>
    fixture.fetch("https://fixture/sync", {
      method: "POST",
      body: JSON.stringify({ count, status }),
    });
  assert.equal((await sync(222)).status, 200);
  let data = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(data.lifetime.downloads, 222);
  assert.equal(data.lifetime.assets, 1);
  assert.equal(data.downloadDays[0].n, 0);
  await sync(227);
  await sync(227);
  await sync(225);
  data = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(data.lifetime.downloads, 227);
  assert.equal(data.downloadDays[0].n, 5);
  assert.equal((await sync(999, 403)).status, 502);
  data = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(data.lifetime.downloads, 227);
  assert.match(data.meta.github_error, /403/);
});
test("the actual downloads Worker preserves bytes and headers, and only scripts enter collection", async () => {
  const fixture = await mf.getWorker("fixture");
  const before = (await (await api("/api/stats")).json()) as Stats;
  const response = await fixture.fetch("https://downloads.localdot.dev/downloads/install.sh", {
    headers: { "user-agent": "curl/8.0" },
  });
  assert.equal(await response.text(), "signed installer bytes");
  assert.equal(response.headers.get("etag"), '"original"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  // waitUntil is intentionally outside the response lifetime; poll the observable write.
  let after = before;
  for (let i = 0; i < 20; i++) {
    after = (await (await api("/api/stats")).json()) as Stats;
    if (after.current.installer_shell === (before.current.installer_shell ?? 0) + 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(after.current.installer_shell, (before.current.installer_shell ?? 0) + 1);
  await fixture.fetch("https://downloads.localdot.dev/downloads/channels/releases.json", {
    headers: { "user-agent": "curl/8.0" },
  });
  const final = (await (await api("/api/stats")).json()) as Stats;
  assert.equal(final.current.installer_shell, after.current.installer_shell);
});
test("reports expose only aggregates and invalid filters are bounded; export is numeric", async () => {
  const res = await api("/api/stats?period=1000000d");
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.range.period, "30d");
  assert.equal(data.timeline.length, 30);
  assert.equal(data.reports.installations, 1);
  assert.ok(!text.includes("private-install-id"));
  const csv = await api("/api/export?period=7d");
  assert.equal(csv.status, 200);
  assert.equal((await csv.text()).split("\r\n").length, 9);
});
test("all dashboard sections render without executable inline scripts or secret links", async () => {
  for (const tab of ["overview", "downloads", "audience", "health", "<script>"]) {
    const res = await api("/stats?tab=" + encodeURIComponent(tab));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes(TOKEN));
    assert.ok(html.includes("localDot"));
  }
});
test("failed background writes never change the original download response", async () => {
  const db = await mf.getD1Database("DB", "admin");
  await db.exec("DROP TABLE counters");
  const fixture = await mf.getWorker("fixture");
  const res = await fixture.fetch("https://fixture/failure", {
    headers: { "user-agent": "curl/8.0" },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "download bytes");
});
test("login brute-force limit is applied without storing addresses", async () => {
  for (let i = 0; i < 12; i++) {
    const res = await mf.dispatchFetch(ORIGIN + "/login", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "192.0.2.77",
      },
      body: "key=wrong",
    });
    if (i >= 10) assert.equal(res.status, 429);
  }
  const db = await mf.getD1Database("DB", "admin");
  const rows = await db.prepare("SELECT * FROM login_limits").all();
  assert.ok(!JSON.stringify(rows).includes("192.0.2.77"));
});

test("download import credential is write-only and bounded", async () => {
  const token = "import-only-0123456789abcdef0123456789";
  const send = (body: string, key = token) =>
    mf.dispatchFetch(ORIGIN + "/internal/github", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });
  assert.equal((await send("[]", TOKEN)).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch(ORIGIN + "/api/stats", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  assert.equal((await send("{}")).status, 400);
  assert.equal((await send("x".repeat(4 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await send("[null]")).status, 502);
  const payload = JSON.stringify([
    {
      draft: false,
      tag_name: "v0.1.0-rc.39",
      published_at: "2026-10-01T00:00:00Z",
      assets: [{ id: 1, name: "localdot-0.1.0-rc.39-darwin-arm64.tgz", download_count: 230 }],
    },
  ]);
  assert.equal((await send(payload)).status, 200);
  const db = await mf.getD1Database("DB", "admin");
  const before = await db.prepare("SELECT * FROM download_days").all();
  assert.equal((await send(payload)).status, 200);
  assert.deepEqual((await db.prepare("SELECT * FROM download_days").all()).results, before.results);
});
