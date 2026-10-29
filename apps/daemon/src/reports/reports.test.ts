import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPORT_LINE_MAX,
  REPORT_LOG_LINES,
  type ReportBundle,
  type ReportDraft,
} from "../../../../packages/protocol/src/reports.ts";
import { createApp } from "../app.ts";
import type { CellSummary } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { buildReport, packReport, type ReportFacts } from "./bundle.ts";
import { reportRedactor } from "./redact.ts";
import { liveFacts, reportRoutes } from "./routes.ts";
import { reportsUrl } from "./service.ts";
import { ReportStore } from "./store.ts";

const TOKEN = "Zx9AqP0l3mN8bVc7Xr2Ty6Ui1Op5As4Df3Gh2Jk1Lq";
const ACCESS = "9f".repeat(32);
const DESKTOPD = "dEsKtOpD-tOkEn_0123456789abcdefghijklmnopq";
const CODE = "Itv4dFzbVVFmlS4bnD5WC2IU1v6-Q2L4bvNo0EedN_Y";
const API_KEY = `sk-ant-api03-${"Q".repeat(40)}`;
const CELL = "01M57SXPQ1FKKC303FWSE80C59";
const FAILED = "01M5W3F2P1NMZC9DZ9JP761JXD";
const DONE = "01M5X0000000000000000000AA";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const event = (seq: number, type: string, data: unknown) =>
  JSON.stringify({
    v: 1,
    id: `01M5W3F2P3PCRC1NPRDXX81R${seq}A`,
    seq,
    t: seq * 1000,
    agent: "main",
    type,
    data,
  });

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "localdot-report-"));
  homes.push(home);
  writeFileSync(join(home, "daemon-token"), `${TOKEN}\n`);
  writeFileSync(
    join(home, "remote-access.json"),
    JSON.stringify({
      enabled: true,
      owner: "ab".repeat(32),
      access: ACCESS,
      domain: "localdot.dev",
    }),
  );
  mkdirSync(join(home, "cells", CELL), { recursive: true });
  writeFileSync(
    join(home, "cells", CELL, "cell.json"),
    JSON.stringify({ v: 2, id: CELL, tokens: { desktopd: DESKTOPD, stream: "s".repeat(43) } }),
  );
  mkdirSync(join(home, "logs"));
  writeFileSync(
    join(home, "logs", "daemon.log"),
    [
      "[2026-10-29T08:00:00.000Z] localdot daemon on http://127.0.0.1:4750 (token in /Users/jordanlee/.localdot/daemon-token)",
      `[2026-10-29T08:00:00.001Z] open http://127.0.0.1:4750/#code=${CODE} (expires in one minute)`,
      `[2026-10-29T08:00:01.000Z] share https://0123456789abcdef0123456789abcdef--dot.localdot.dev/_remote/pair#remote=${ACCESS}&code=x`,
      "[2026-10-29T08:00:02.000Z] tailscale serve on https://jordans-mbp.tail1234.ts.net",
      `[2026-10-29T08:00:03.000Z] provider said 401 for ${API_KEY} (jordan@example.com)`,
      "[2026-10-29T08:00:04.000Z] public address 203.0.113.77 refused; gate at 172.18.0.2",
      `[2026-10-29T08:00:05.000Z] Authorization: Bearer ${TOKEN}`,
      `[2026-10-29T08:00:06.000Z] desktopd answered with ${DESKTOPD}-stale`,
      '[2026-10-29T08:00:07.000Z] unlock failed passphrase="correct horse battery staple"',
      `[2026-10-29T08:00:08.000Z] signed in as ${userInfo().username} on ${hostname()}`,
      "    at migrationPlan (/Users/jordanlee/builds/localdot/apps/daemon/src/cells/system-migration-plan.ts:48:31)",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(home, "logs", "keyd.log"),
    `${"keyd(53401) MallocStackLogging: off\n".repeat(3)}`,
  );
  const failed = join(home, "sessions", FAILED);
  mkdirSync(failed, { recursive: true });
  writeFileSync(
    join(failed, "session.json"),
    JSON.stringify({
      id: FAILED,
      title: "Book a table at Luigi's for 4",
      startedAt: "2026-10-26T12:37:48.354Z",
    }),
  );
  writeFileSync(
    join(failed, "summary.json"),
    JSON.stringify({
      id: FAILED,
      title: "Book a table at Luigi's for 4",
      startedAt: "2026-10-26T12:37:48.354Z",
      durationMs: 61000,
      verdict: "failed",
      steps: 12,
      failedSteps: 2,
    }),
  );
  writeFileSync(
    join(failed, "events.jsonl"),
    [
      event(0, "session.start", {
        screen: { w: 2560, h: 1600, scale: 2 },
        os: "linux",
        title: "Book a table at Luigi's for 4",
      }),
      event(1, "message.user", { messageId: "m", text: "Use my card 4242 4242 4242 4242" }),
      event(2, "agent.state", { state: "thinking" }),
      event(3, "model.usage", {
        role: "main",
        route: "anthropic",
        model: "claude-sonnet-5-5",
        inputTokens: 1,
        outputTokens: 1,
      }),
      event(4, "model.retry", {
        role: "main",
        attempt: 1,
        waitMs: 1000,
        status: 529,
        message: "Overloaded",
      }),
      event(5, "message.assistant", {
        messageId: "a",
        text: "I couldn't continue: the brain kept crashing.",
      }),
      event(6, "agent.state", { state: "error", reason: "the brain kept crashing" }),
      event(7, "session.end", { reason: "error" }),
      "",
    ].join("\n"),
  );
  const done = join(home, "sessions", DONE);
  mkdirSync(done, { recursive: true });
  writeFileSync(
    join(done, "events.jsonl"),
    `${[event(0, "agent.state", { state: "done" }), event(1, "session.end", { reason: "done" })].join("\n")}\n`,
  );
  return home;
}

const cell = (overrides: Partial<CellSummary> = {}): CellSummary => ({
  id: CELL,
  state: "ready",
  scale: 2,
  createdAt: "2026-10-20T00:00:00.000Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  ...overrides,
});

const facts = (overrides: Partial<ReportFacts> = {}): ReportFacts => ({
  version: "1.4.0-rc.2",
  install: "managed",
  app: "running",
  keyd: "ready",
  doctor: [
    { name: "docker-engine", ok: true, detail: "Docker Engine 29.2.0" },
    { name: "image-desktop", ok: false, detail: "localdot/desktop:1.4.0 is missing" },
  ],
  computers: [
    {
      cell: cell({ paused: true }),
      browser: { state: "failed", problem: "dot's web browser couldn't start.", restarts: 2 },
      supervisor: {
        state: "stopped",
        restarts: 2,
        lastFailure: {
          kind: "browser_exited",
          detail: "exit status 133",
          recovered: false,
          at: "2026-10-29T08:00:00.000Z",
        },
      },
    },
  ],
  ...overrides,
});

describe("report redaction", () => {
  it("masks secrets, sign-in and relay links, emails, addresses and names in log lines", () => {
    const home = fixtureHome();
    const redact = reportRedactor(home);
    const out = redact(
      [
        `open http://127.0.0.1:4750/#code=${CODE}`,
        `share https://0123456789abcdef0123456789abcdef--dot.localdot.dev/_remote/pair#remote=${ACCESS}&code=x`,
        `${API_KEY} jordan@example.com 203.0.113.77 172.18.0.2 ${DESKTOPD}-stale`,
        `/Users/jordanlee/builds C:\\Users\\Jordan\\AppData ${userInfo().username} ${hostname()}`,
        'passphrase="correct horse" https://jordans-mbp.tail1234.ts.net',
      ].join("\n"),
    );
    for (const secret of [
      CODE,
      ACCESS,
      API_KEY,
      DESKTOPD,
      "jordan@example.com",
      "203.0.113.77",
      "jordanlee",
      "Jordan\\",
      "correct horse",
      "jordans-mbp",
      "--dot.localdot.dev",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain("172.18.0.2");
    expect(out).toContain("/Users/[user]/builds");
    expect(out).toContain("[relay]");
    expect(out).toContain("[tailnet]");
    expect(out.split("\n")).toHaveLength(5);
  });
});

describe("report bundle", () => {
  it("holds states, reasons and redacted logs, never task text unless asked", () => {
    const home = fixtureHome();
    const bundle = buildReport({
      home,
      installId: "0123456789abcdef0123456789abcdef",
      facts: facts(),
      ask: {
        source: "app",
        message: "It stopped while booking.\nMy email is jordan@example.com",
        context: { kind: "task", sessionId: FAILED, reason: "the brain kept crashing" },
      },
      now: new Date("2026-10-29T09:00:00.000Z"),
    });
    const text = JSON.stringify(bundle);
    for (const hidden of [
      "Luigi",
      "4242",
      TOKEN,
      DESKTOPD,
      CODE,
      ACCESS,
      API_KEY,
      "jordanlee",
      "jordan@example.com",
      "203.0.113.77",
      "correct horse",
      userInfo().username,
    ])
      expect(text).not.toContain(hidden);
    expect(bundle.summary).toBe("Task: the brain kept crashing");
    expect(bundle.message).toBe("It stopped while booking.\nMy email is [email]");
    expect(bundle.app).toMatchObject({ version: "1.4.0-rc.2", channel: "rc", install: "managed" });
    const task = bundle.tasks.find((t) => t.id === FAILED);
    expect(task).toMatchObject({
      ended: "error",
      verdict: "failed",
      steps: 12,
      failedSteps: 2,
      states: [{ state: "error", reason: "the brain kept crashing" }],
      retries: [{ status: 529, message: "Overloaded" }],
      models: ["anthropic claude-sonnet-5-5"],
    });
    expect(task?.request).toBeUndefined();
    expect(bundle.tasks.map((t) => t.id)).toEqual([DONE, FAILED]);
    expect(bundle.computers[0]).toMatchObject({
      flags: ["paused"],
      browser: {
        state: "failed",
        lastFailure: { kind: "browser_exited", detail: "exit status 133" },
      },
    });
    expect(bundle.logs.map((log) => log.name)).toEqual(["logs/daemon.log", "logs/keyd.log"]);
    expect(gunzipSync(packReport(bundle)).toString()).toBe(text);
  });

  it("includes what the user asked for only in the task the report is about, when they say so", () => {
    const home = fixtureHome();
    const bundle = buildReport({
      home,
      installId: "0123456789abcdef0123456789abcdef",
      facts: facts(),
      ask: { source: "cli", context: { kind: "task", sessionId: FAILED }, includeRequest: true },
    });
    expect(bundle.summary).toBe("Task: the brain kept crashing");
    expect(bundle.tasks.find((t) => t.id === FAILED)?.request).toBe(
      "Book a table at Luigi's for 4",
    );
    expect(bundle.tasks.find((t) => t.id === DONE)?.request).toBeUndefined();
  });

  it("keeps logs within their caps and reads a managed installation's logs", () => {
    const home = fixtureHome();
    const long = `${"x".repeat(3000)}\n`;
    writeFileSync(join(home, "logs", "daemon.log"), long.repeat(1000));
    mkdirSync(join(home, "install", "logs"), { recursive: true });
    writeFileSync(join(home, "install", "logs", "daemon.error.log"), "launchd: exited 1\n");
    const bundle = buildReport({
      home,
      installId: "0123456789abcdef0123456789abcdef",
      facts: facts({ app: "stopped", doctor: undefined, computers: [] }),
      ask: { source: "cli" },
    });
    const daemon = bundle.logs.find((log) => log.name === "logs/daemon.log");
    expect(daemon?.truncated).toBe(true);
    expect(daemon?.lines.length).toBeLessThanOrEqual(REPORT_LOG_LINES);
    expect(Math.max(...(daemon?.lines ?? []).map((line) => line.length))).toBe(REPORT_LINE_MAX);
    expect(bundle.logs.map((log) => log.name)).toContain("install/logs/daemon.error.log");
    expect(bundle.summary).toBe("localDot isn't running");
    expect(bundle.doctor).toBeUndefined();
  });
});

describe("report store", () => {
  it("keeps one private installation id, the choice, and what was sent", () => {
    const home = fixtureHome();
    const store = new ReportStore(home);
    expect(store.overview()).toEqual({ enabled: true, sent: [] });
    const id = store.installId();
    expect(store.installId()).toBe(id);
    expect(statSync(join(home, "reports.json")).mode & 0o777).toBe(0o600);
    store.record({
      id: "LD-7K3P-Q9XA",
      token: "t".repeat(43),
      sentAt: "2026-10-29T09:00:00.000Z",
      summary: "s",
    });
    expect(store.overview().sent).toEqual([
      { id: "LD-7K3P-Q9XA", sentAt: "2026-10-29T09:00:00.000Z", summary: "s" },
    ]);
    expect(store.setEnabled(false).enabled).toBe(false);
    expect(new ReportStore(home).installId()).toBe(id);
    writeFileSync(join(home, "reports.json"), "{");
    expect(store.read().enabled).toBe(false);
  });
});

describe("the reports API", () => {
  const RECEIPT = { id: "LD-7K3P-Q9XA", token: "t".repeat(43) };
  function app(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}) {
    const home = fixtureHome();
    const store = new ReportStore(home);
    const routes = new Hono();
    reportRoutes(routes, { home, store, env, facts: async () => facts(), fetch: fetchImpl });
    return { routes, store };
  }
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("sends exactly the reviewed report, then shows and deletes it with its token", async () => {
    const posted: ReportBundle[] = [];
    const service = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://reports.localdot.dev");
      if (init?.method === "POST") {
        expect(new Headers(init.headers).get("content-type")).toBe(
          "application/vnd.localdot.report+gzip",
        );
        posted.push(JSON.parse(gunzipSync(init.body as Buffer).toString()));
        return new Response(JSON.stringify(RECEIPT), { status: 201 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${RECEIPT.token}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: RECEIPT.id,
        status: "investigating",
        receivedAt: "2026-10-29T09:00:00.000Z",
        updatedAt: "2026-10-29T10:00:00.000Z",
      });
    }) as unknown as typeof fetch;
    const { routes, store } = app(service);

    const drafted = await routes.request(
      "/api/reports/drafts",
      json("POST", { message: "Blank page" }),
    );
    expect(drafted.status).toBe(200);
    const draft = (await drafted.json()) as ReportDraft;
    expect(draft.bundle.message).toBe("Blank page");
    const sent = await routes.request(`/api/reports/drafts/${draft.draft}/send`, {
      method: "POST",
    });
    expect(await sent.json()).toMatchObject({ id: RECEIPT.id, summary: "Blank page" });
    expect(posted).toEqual([draft.bundle]);
    expect(store.find(RECEIPT.id)?.token).toBe(RECEIPT.token);
    const overview = await (await routes.request("/api/reports")).text();
    expect(overview).toContain(RECEIPT.id);
    expect(overview).not.toContain(RECEIPT.token);
    // A sent draft can't be sent twice.
    expect(
      (await routes.request(`/api/reports/drafts/${draft.draft}/send`, { method: "POST" })).status,
    ).toBe(404);

    expect(await (await routes.request(`/api/reports/sent/${RECEIPT.id}`)).json()).toMatchObject({
      status: "investigating",
    });
    expect(
      (await routes.request(`/api/reports/sent/${RECEIPT.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(store.find(RECEIPT.id)).toBeUndefined();
    expect((await routes.request(`/api/reports/sent/${RECEIPT.id}`)).status).toBe(404);
  });

  it("refuses while reporting is off and explains the service's refusals", async () => {
    const service = vi.fn(
      async () =>
        new Response("Too many reports from this computer. Try again in an hour.", { status: 429 }),
    ) as unknown as typeof fetch;
    const { routes } = app(service);
    expect((await routes.request("/api/reports", json("PUT", { enabled: false }))).status).toBe(
      200,
    );
    expect((await routes.request("/api/reports/drafts", json("POST", {}))).status).toBe(403);
    await routes.request("/api/reports", json("PUT", { enabled: true }));
    const draft = (await (
      await routes.request("/api/reports/drafts", json("POST", {}))
    ).json()) as ReportDraft;
    const refused = await routes.request(`/api/reports/drafts/${draft.draft}/send`, {
      method: "POST",
    });
    expect(refused.status).toBe(502);
    expect(await refused.text()).toBe("Too many reports from this computer. Try again in an hour.");
    expect(
      (
        await routes.request(
          "/api/reports/drafts",
          json("POST", { context: { kind: "task", sessionId: "nope" } }),
        )
      ).status,
    ).toBe(400);
  });

  it("answers only with the install token", async () => {
    const home = fixtureHome();
    const token = "t".repeat(43);
    const daemon = createApp({
      token,
      port: 4750,
      eventLog: new EventLog(home),
      reports: { home, store: new ReportStore(home), env: {}, facts: async () => facts() },
    });
    const url = "http://127.0.0.1:4750/api/reports";
    expect((await daemon.request(url)).status).toBe(401);
    const ok = await daemon.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts only an https reports address, or plain http on loopback", () => {
    expect(reportsUrl({}).href).toBe("https://reports.localdot.dev/");
    expect(reportsUrl({ LOCALDOT_REPORTS_URL: "http://127.0.0.1:8787" }).host).toBe(
      "127.0.0.1:8787",
    );
    for (const value of [
      "http://reports.example.com",
      "https://user:pw@reports.example.com",
      "https://reports.example.com/?k=v",
    ])
      expect(() => reportsUrl({ LOCALDOT_REPORTS_URL: value })).toThrow(/https/);
  });
});

describe("live facts", () => {
  it("reads the daemon's own state and keeps going when a check fails", async () => {
    const result = await liveFacts(
      {
        install: "source",
        updater: {
          status: async () =>
            ({
              currentVersion: "a".repeat(40),
              phase: "idle",
              availableVersion: null,
              error: null,
            }) as never,
        },
        keyd: { status: async () => ({ vault: { state: "locked" } }) as never },
        cells: { list: () => [cell()] },
        browser: {
          status: async () => ({ state: "ready", restarts: 1 }),
          supervisor: async () => undefined,
        },
        remote: () => ({ enabled: true, state: "online" }),
        doctor: async () => {
          throw new Error("docker went away");
        },
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      version: "a".repeat(40),
      keyd: "locked",
      remoteAccess: { enabled: true, state: "online" },
      computers: [{ cell: { id: CELL }, browser: { state: "ready", restarts: 1 } }],
    });
    expect(result.doctor).toBeUndefined();
  });
});
