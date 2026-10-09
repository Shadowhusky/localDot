import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NOTIFY_SETTINGS, type EventDraft } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydError, KeydUnavailableError } from "../keyd/client.ts";
import { AttentionLedger } from "./attention.ts";
import { deviceIdOf, NotifyStore } from "./store.ts";
import { browserKeys } from "./testing/ece-decrypt.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const bearer = { authorization: `Bearer ${TOKEN}` };
const json = { ...bearer, "content-type": "application/json" };
const PUBLIC_KEY = `B${"Q".repeat(86)}`;

let home: string;
let log: EventLog;
let store: NotifyStore;
let ledger: AttentionLedger;
let keyFailure: Error | undefined;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-notify-routes-"));
  log = new EventLog(home);
  store = new NotifyStore(home);
  ledger = new AttentionLedger();
  log.subscribe((id, event) => ledger.observe(id, event));
  keyFailure = undefined;
  app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: log,
    notify: {
      store,
      ledger,
      keyd: {
        pushKey: async () => {
          if (keyFailure) throw keyFailure;
          return { publicKey: PUBLIC_KEY };
        },
      },
      notifier: { test: async () => ({ mac: "shown", phones: [] }) },
      banner: "none",
    },
  });
});
afterEach(() => {
  log.close();
  rmSync(home, { recursive: true, force: true });
});

describe("notify routes", () => {
  it("needs the install token on every route", async () => {
    for (const [method, path] of [
      ["GET", "/api/notify/settings"],
      ["GET", "/api/notify/host"],
      ["PUT", "/api/notify/settings"],
      ["GET", "/api/notify/key"],
      ["GET", "/api/notify/subscriptions"],
      ["POST", "/api/notify/subscriptions"],
      ["DELETE", "/api/notify/subscriptions/0123456789abcdef"],
      ["POST", "/api/notify/test"],
      ["GET", "/api/notify/attention"],
      ["POST", "/api/notify/seen"],
    ] as const)
      expect((await app.request(url(path), { method })).status, `${method} ${path}`).toBe(401);
  });

  it("says how this computer shows banners", async () => {
    expect(await (await app.request(url("/api/notify/host"), { headers: bearer })).json()).toEqual({
      banner: "none",
    });
  });

  it("reads and saves settings, refusing anything else", async () => {
    expect(
      await (await app.request(url("/api/notify/settings"), { headers: bearer })).json(),
    ).toEqual(DEFAULT_NOTIFY_SETTINGS);
    const next = { ...DEFAULT_NOTIFY_SETTINGS, showTaskText: true };
    const saved = await app.request(url("/api/notify/settings"), {
      method: "PUT",
      headers: json,
      body: JSON.stringify(next),
    });
    expect(saved.status).toBe(200);
    expect(store.settings().showTaskText).toBe(true);
    const bad = await app.request(url("/api/notify/settings"), {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ ...next, extra: true }),
    });
    expect(bad.status).toBe(400);
  });

  it("gives the push key, and says why when it cannot", async () => {
    expect(await (await app.request(url("/api/notify/key"), { headers: bearer })).json()).toEqual({
      publicKey: PUBLIC_KEY,
    });
    keyFailure = new KeydUnavailableError("ECONNREFUSED", "/v1/push/key");
    expect((await app.request(url("/api/notify/key"), { headers: bearer })).status).toBe(503);
    keyFailure = new KeydError(409, "key-name-taken", "x", "/v1/push/key");
    const taken = await app.request(url("/api/notify/key"), { headers: bearer });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toMatch(/webpush-vapid/);
  });

  it("adds, lists and removes a device without ever returning its endpoint or keys", async () => {
    const { p256dh, auth } = browserKeys();
    const endpoint = "https://web.push.apple.com/QGuR-device";
    const added = await app.request(url("/api/notify/subscriptions"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ endpoint, keys: { p256dh, auth }, label: "iPhone" }),
    });
    expect(added.status).toBe(201);
    const listed = await (
      await app.request(url("/api/notify/subscriptions"), { headers: bearer })
    ).text();
    expect(listed).toContain(deviceIdOf(endpoint));
    expect(listed).not.toContain("QGuR-device");
    expect(listed).not.toContain(p256dh);
    const refused = await app.request(url("/api/notify/subscriptions"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        endpoint: "https://evil.example/x",
        keys: { p256dh, auth },
        label: "x",
      }),
    });
    expect(refused.status).toBe(400);
    const id = deviceIdOf(endpoint);
    expect(
      (
        await app.request(url(`/api/notify/subscriptions/${id}`), {
          method: "DELETE",
          headers: bearer,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(url(`/api/notify/subscriptions/${id}`), {
          method: "DELETE",
          headers: bearer,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(url("/api/notify/subscriptions/..%2f"), {
          method: "DELETE",
          headers: bearer,
        })
      ).status,
    ).toBe(400);
  });

  it("lists open attention and marks a session seen", async () => {
    const id = log.createSession("Tidy the downloads");
    log.append(id, {
      type: "agent.state",
      agent: "main",
      data: { state: "done" },
    } as unknown as EventDraft);
    const open = (await (
      await app.request(url("/api/notify/attention"), { headers: bearer })
    ).json()) as {
      items: { sessionId: string; level: string }[];
    };
    expect(open.items).toMatchObject([{ sessionId: id, level: "done" }]);
    const seen = await app.request(url("/api/notify/seen"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sessionId: id }),
    });
    expect(seen.status).toBe(204);
    expect(ledger.snapshot()).toEqual([]);
  });

  it("refuses a body over 8 KiB", async () => {
    const res = await app.request(url("/api/notify/settings"), {
      method: "PUT",
      headers: { ...json, "content-length": String(9000) },
      body: "x".repeat(9000),
    });
    expect(res.status).toBe(413);
  });
});
