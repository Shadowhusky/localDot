import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, keyLikePresent, ulid } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { AppEvents } from "../app-events.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "../keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import type { MacNotifier } from "./mac.ts";
import { browserKeys, decryptPush } from "./testing/ece-decrypt.ts";
import {
  type FakePushService,
  startFakePushService,
  verifyVapid,
} from "./testing/fake-push-service.ts";
import { createNotify, type NotifyWiring } from "./wiring.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const MODEL_TEXT = `I will now send it. MODEL-TEXT-7f3a sk-ant-api03-${"b".repeat(90)}`;
const CARD_TITLE = "Send the statement to accounts@example.test";

let home: string;
let log: EventLog;
let keyd: FakeKeyd;
let push: FakePushService;
let notify: NotifyWiring;
let banners: [string, string][];
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ld-push-flow-"));
  log = new EventLog(home);
  keyd = await startFakeKeyd();
  push = await startFakePushService();
  keyd.pushTarget = (endpoint) => `${push.url}/${endpoint.hostname}${endpoint.pathname}`;
  banners = [];
  const mac: MacNotifier = {
    available: true,
    show: async (title, body) => {
      banners.push([title, body]);
      return "shown";
    },
  };
  notify = createNotify({
    home,
    eventLog: log,
    keyd: new KeydClient(keyd.socketPath, 5000),
    events: new AppEvents(),
    mac,
    timeZone: () => "UTC",
    settleMs: 50,
  });
  app = createApp({ token: TOKEN, port: PORT, eventLog: log, notify: notify.routes });
});
afterEach(async () => {
  notify.close();
  await push.close();
  await keyd.close();
  log.close();
  rmSync(home, { recursive: true, force: true });
});

const append = (id: string, type: string, data: Record<string, unknown>) =>
  log.append(id, { type, agent: "main", data } as unknown as EventDraft);

async function subscribe(endpoint: string, label: string) {
  const keys = browserKeys();
  const res = await app.request(`http://127.0.0.1:${PORT}/api/notify/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label }),
  });
  expect(res.status).toBe(201);
  return keys;
}

function approvalSession(): string {
  const id = log.createSession("Pay the electricity bill");
  append(id, "session.start", {
    screen: { w: 1280, h: 800, scale: 1 },
    os: "linux",
    title: "Pay the electricity bill",
  });
  append(id, "message.delta", { messageId: ulid(), text: MODEL_TEXT });
  append(id, "approval.request", {
    actionClass: "send",
    risk: "high",
    title: CARD_TITLE,
    kind: "send",
    preview: { fields: [["To", "accounts@example.test"]] },
    approvalId: ulid(),
    generation: 1,
    revision: 1,
    expiresAt: Date.now() + 600_000,
  });
  return id;
}

describe("phone push for an approval (acceptance 2 and 3)", () => {
  it("sends one message per device whose payload is only kind and session", async () => {
    const phone = await subscribe("https://web.push.apple.com/phone-1", "iPhone");
    const tablet = await subscribe("https://fcm.googleapis.com/fcm/send/tablet-1", "Tablet");
    const sessionId = approvalSession();
    await vi.waitFor(() => expect(push.received).toHaveLength(2), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(push.received).toHaveLength(2);
    const plain: string[] = [];
    for (const delivery of push.received) {
      const keys = delivery.path.includes("phone-1") ? phone : tablet;
      const text = decryptPush(delivery.body, keys.privateKey, keys.authSecret).toString();
      plain.push(text);
      expect(JSON.parse(text)).toEqual({ kind: "needs_you", sessionId });
      const origin = delivery.path.includes("phone-1")
        ? "https://web.push.apple.com"
        : "https://fcm.googleapis.com";
      expect(verifyVapid(delivery.headers.authorization, keyd.pushPublicKey)).toMatchObject({
        aud: origin,
      });
      expect(delivery.headers).toMatchObject({
        "content-encoding": "aes128gcm",
        ttl: "600",
        urgency: "high",
        topic: sessionId,
      });
    }
    const outside = [
      ...plain,
      ...push.received.map((d) => JSON.stringify(d.headers)),
      ...keyd.calls.map(({ body }) => JSON.stringify({ ...(body as object), body: undefined })),
    ].join("\n");
    expect(outside).not.toContain("MODEL-TEXT-7f3a");
    expect(outside).not.toContain(CARD_TITLE);
    expect(outside).not.toContain("Pay the electricity bill");
    expect(keyLikePresent(outside)).toBe(false);
    expect(banners).toEqual([["dot needs you", "Pay the electricity bill"]]);
    expect(keyLikePresent(banners.flat().join("\n"))).toBe(false);
  });

  it("adds the task's title, never model text, once the user opts in", async () => {
    const phone = await subscribe("https://web.push.apple.com/phone-2", "iPhone");
    notify.store.putSettings({ ...notify.store.settings(), showTaskText: true });
    const sessionId = approvalSession();
    await vi.waitFor(() => expect(push.received).toHaveLength(1), { timeout: 3000 });
    const text = decryptPush(
      push.received[0]?.body ?? Buffer.alloc(0),
      phone.privateKey,
      phone.authSecret,
    ).toString();
    expect(JSON.parse(text)).toEqual({
      kind: "needs_you",
      sessionId,
      title: "Pay the electricity bill",
    });
    expect(text).not.toContain("MODEL-TEXT-7f3a");
  });

  it("forgets a device its push service says is gone", async () => {
    await subscribe("https://web.push.apple.com/gone-1", "Old phone");
    push.statuses.set("/web.push.apple.com/gone-1", 410);
    approvalSession();
    await vi.waitFor(() => expect(notify.store.devices()).toEqual([]), { timeout: 3000 });
  });

  it("does not ping again for anything that happened before a restart", async () => {
    await subscribe("https://web.push.apple.com/phone-3", "iPhone");
    approvalSession();
    await vi.waitFor(() => expect(push.received).toHaveLength(1), { timeout: 3000 });
    notify.close();
    notify = createNotify({
      home,
      eventLog: log,
      keyd: new KeydClient(keyd.socketPath, 5000),
      events: new AppEvents(),
      mac: { available: true, show: async () => "shown" },
      timeZone: () => "UTC",
      settleMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(push.received).toHaveLength(1);
    expect(notify.ledger.snapshot()).toEqual([]);
    expect(notify.store.devices()).toHaveLength(1);
  });

  it("keeps quiet hours: Done stays silent, Needs you still comes through (acceptance 4)", async () => {
    notify.close();
    banners = [];
    notify = createNotify({
      home,
      eventLog: log,
      keyd: new KeydClient(keyd.socketPath, 5000),
      events: new AppEvents(),
      mac: {
        available: true,
        show: async (title, body) => {
          banners.push([title, body]);
          return "shown";
        },
      },
      // 23:30 in London.
      now: () => new Date("2026-10-08T22:30:00Z"),
      timeZone: () => "Europe/London",
      settleMs: 50,
    });
    app = createApp({ token: TOKEN, port: PORT, eventLog: log, notify: notify.routes });
    await subscribe("https://web.push.apple.com/phone-4", "iPhone");
    notify.store.putSettings({
      ...notify.store.settings(),
      quietHours: { enabled: true, start: "22:00", end: "07:00", allowNeedsYou: true },
    });
    const finished = log.createSession("Tidy the downloads");
    append(finished, "agent.state", { state: "done" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(push.received).toHaveLength(0);
    expect(banners).toEqual([]);
    approvalSession();
    await vi.waitFor(() => expect(push.received).toHaveLength(1), { timeout: 3000 });
    expect(banners).toEqual([["dot needs you", "Pay the electricity bill"]]);
  });
});
