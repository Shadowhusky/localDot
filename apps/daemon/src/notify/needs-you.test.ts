import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttentionChangeEvent,
  type Blocker,
  type EventDraft,
  type KeydPushRequest,
  PushPayload,
  ulid,
} from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppEvents } from "../app-events.ts";
import { EventLog } from "../event-log.ts";
import { browserKeys, decryptPush } from "./testing/ece-decrypt.ts";
import { createNotify, type NotifyWiring } from "./wiring.ts";

// Every way dot waits for the user, from the journal event the task appends to what reaches the
// Mac's banner and the phones: the furthest a test gets. Whether macOS or iOS then draws the
// banner is theirs to decide, and is not tested here.

const draft = (type: string, data: Record<string, unknown>) =>
  ({ type, agent: "main", data }) as unknown as EventDraft;

const approval = (kind: "send" | "permission") =>
  draft("approval.request", {
    actionClass: kind === "send" ? "send" : "network",
    risk: "high",
    title: kind === "send" ? "Send the statement" : "Let curl reach api.example.test:443",
    kind,
    preview: { fields: [] },
    approvalId: ulid(),
    generation: 1,
    revision: 1,
    expiresAt: Date.now() + 600_000,
  });

const blocker = (value: Blocker) =>
  draft("blocker.raise", { blockerId: ulid(), blocker: value, by: "localdot" });

const NEEDS_YOU: Record<string, EventDraft> = {
  question: draft("ask.request", {
    askId: ulid(),
    question: "Which report format should I use?",
    options: [{ key: "A", text: "Markdown" }],
    allowText: true,
  }),
  approval: approval("send"),
  "connection card": approval("permission"),
  "hand-over": draft("takeover.request", {
    requestId: ulid(),
    reason: "login",
    note: "Sign in to the bank, then give it back",
  }),
  "keys locked": blocker({ kind: "keys_locked" }),
  "key refused": blocker({ kind: "key", id: "anthropic-main", problem: "rejected" }),
  "key to enter again": blocker({ kind: "key", id: "anthropic-main", problem: "reenter" }),
  "app to connect": blocker({
    kind: "app",
    connector: "linear",
    name: "Linear",
    host: "mcp.linear.app",
  }),
  "model refused": blocker({ kind: "model", reason: "model refused", detail: "400: no images" }),
  "provider limit": blocker({ kind: "model", reason: "provider limit reached" }),
  "computer stopped": blocker({ kind: "computer", state: "stopped" }),
  "computer paused": blocker({ kind: "computer", state: "paused" }),
  "Docker stopped": blocker({ kind: "runtime" }),
};

let home: string;
let log: EventLog;
let events: AppEvents;
let notify: NotifyWiring;
let banners: [string, string][];
let pushes: KeydPushRequest[];
const phone = browserKeys();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-needs-you-"));
  log = new EventLog(home);
  events = new AppEvents();
  // Each test's own lists: a timer a test left behind can't write into the next one's.
  const shownHere: [string, string][] = [];
  const pushedHere: KeydPushRequest[] = [];
  banners = shownHere;
  pushes = pushedHere;
  notify = createNotify({
    home,
    eventLog: log,
    events,
    keyd: {
      pushKey: async () => ({ publicKey: "A".repeat(87) }),
      pushSend: async (request) => {
        pushedHere.push(request);
        return { status: 201, gone: false };
      },
    },
    mac: {
      available: true,
      show: async (title, body) => {
        shownHere.push([title, body]);
        return "shown";
      },
    },
    timeZone: () => "UTC",
    settleMs: 20,
  });
  notify.store.subscribe({
    endpoint: "https://web.push.apple.com/phone-1",
    keys: { p256dh: phone.p256dh, auth: phone.auth },
    label: "iPhone",
  });
});
afterEach(() => {
  notify.close();
  log.close();
  rmSync(home, { recursive: true, force: true });
});

function task(title: string): string {
  const id = log.createSession(title);
  log.append(
    id,
    draft("session.start", { screen: { w: 1280, h: 800, scale: 2 }, os: "linux", title }),
  );
  log.append(id, draft("message.user", { messageId: ulid(), text: title, kind: "task" }));
  return id;
}

const pushed = (request: KeydPushRequest) =>
  PushPayload.parse(
    JSON.parse(
      decryptPush(
        Buffer.from(request.body, "base64url"),
        phone.privateKey,
        phone.authSecret,
      ).toString(),
    ),
  );

// A tab of localDot open on this Mac, behind another app, that may show notifications itself and
// says it did as soon as it asks the browser to.
function hiddenTab() {
  const tab = notify.presence.connect(true);
  tab.update({ type: "presence", visible: false, canNotify: true });
  const asked: AttentionChangeEvent[] = [];
  const stop = events.subscribe((event) => {
    if (event.type !== "attention.change" || !event.page) return;
    asked.push(event);
    notify.presence.shown(event.item.key);
  });
  return {
    asked,
    close: () => {
      stop();
      tab.close();
    },
  };
}

describe("every way dot needs you", () => {
  for (const [name, event] of Object.entries(NEEDS_YOU))
    it(`reaches this Mac's banner and the phones: ${name}`, async () => {
      const id = task(`Pay the bill (${name})`);
      log.append(id, event);
      await vi.waitFor(() => expect(banners).toHaveLength(1), { timeout: 2000 });
      await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 2000 });
      expect(banners).toEqual([["dot needs you", `Pay the bill (${name})`]]);
      expect(pushed(pushes[0] as KeydPushRequest)).toEqual({ kind: "needs_you", sessionId: id });
      expect(pushes[0]).toMatchObject({ urgency: "high", topic: id });
    });

  it("says nothing when the user took the computer themselves", async () => {
    const id = task("Pay the bill");
    log.append(
      id,
      draft("takeover.request", { requestId: ulid(), reason: "other", note: "", by: "user" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(banners).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("asks again, on every device, when the same task needs you a second time", async () => {
    const id = task("Pay the bill");
    log.append(id, NEEDS_YOU.question as EventDraft);
    await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 2000 });
    log.append(id, approval("send"));
    await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 2000 });
    expect(banners).toHaveLength(2);
  });

  // The cause of "a test shows a banner but a real Needs you doesn't": a test always posts
  // localDot's own banner, while a real one went to an open tab's browser notification whenever a
  // tab could show one, and the Mac's banner stood down as soon as the tab said it had. Whether
  // the browser's notifications reach the screen (Chrome or Safari allowed in System Settings,
  // a Focus that lets them through) is nothing a page can tell.
  it("shows this Mac's own banner, the one a test shows, while a tab is open behind another app", async () => {
    const tab = hiddenTab();
    const id = task("Pay the bill");
    log.append(id, NEEDS_YOU["model refused"] as EventDraft);
    await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 2000 });
    await vi.waitFor(() => expect(banners).toEqual([["dot needs you", "Pay the bill"]]), {
      timeout: 2000,
    });
    expect(tab.asked).toEqual([]);
    tab.close();
  });

  it("leaves the Mac quiet while someone looks at localDot there, and still tells the phones", async () => {
    const tab = notify.presence.connect(true);
    tab.update({ type: "presence", visible: true, canNotify: true });
    const id = task("Pay the bill");
    log.append(id, NEEDS_YOU.question as EventDraft);
    await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(banners).toEqual([]);
    tab.close();
  });
});
