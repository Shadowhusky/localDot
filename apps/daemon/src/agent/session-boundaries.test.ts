import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, ControlHeldError, SessionStoppedError } from "./session.ts";
import { TranscriptStore } from "./transcript.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync("/tmp/ld-session-");
  homes.push(home);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), ulid(), "task", {
    append: (_id, event) => {
      events.push(event);
      return event as never;
    },
  });
  const generation = session.beginBrain();
  const store = new TranscriptStore(home);
  return { session, generation, store, events, home };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("daemon-owned generations and control", () => {
  it("retires synchronously without clearing the replacement's credentials", () => {
    const { session, generation } = setup();
    const lease = session.admit(generation);
    session.toolToken = "old";
    session.retireBrain(generation);
    expect(lease.signal.aborted).toBe(true);
    expect(session.toolToken).toBeUndefined();
    const next = session.beginBrain();
    session.toolToken = "next";
    session.retireBrain(generation);
    expect(session.isCurrent(next)).toBe(true);
    expect(session.toolToken).toBe("next");
    expect(() => lease.check()).toThrow();
    lease.finish();
  });
  it("holds takeover across caller loss, messages, status and duplicate hand-back", async () => {
    const { session, generation, events } = setup();
    const lease = session.admit(generation);
    const outcome = session.takeover("login", "Please log in", undefined, lease);
    const rejected = expect(outcome).rejects.toBeDefined();
    await flush();
    const requestId = required(session.pendingTakeover);
    session.retireBrain(generation);
    await rejected;
    lease.finish();
    session.post("followup", "continue later");
    session.setStatus("running");
    expect(session.status).toBe("waiting_user");
    expect(() => session.beginBrain()).toThrow(ControlHeldError);
    expect(events.filter((e) => e.type === "takeover.end")).toHaveLength(0);
    expect(session.endTakeover(requestId, "Logged in")).toBe(true);
    expect(session.endTakeover(requestId, "duplicate")).toBe(false);
    const next = session.beginBrain();
    expect((await session.inbox(0, 0, undefined, next)).items.map((i) => i.text)).toEqual([
      "continue later",
      "Logged in",
    ]);
    expect(events.filter((e) => e.type === "takeover.request")).toHaveLength(1);
    expect(events.filter((e) => e.type === "takeover.end")).toHaveLength(1);
  });
  it("notifies control owners synchronously before canceling tools and preserves the daemon hold", async () => {
    const { session, generation, events } = setup();
    const lease = session.admit(generation);
    const notified: string[] = [];
    let heldAtNotification = false,
      canceledAtNotification = true;
    session.onControlRequested(generation, () => {
      notified.push("first");
      heldAtNotification = session.controlHeld;
      canceledAtNotification = lease.signal.aborted;
      session.retireBrain(generation);
    });
    session.onControlRequested(generation, () => notified.push("second"));
    const outcome = session.takeover("login", "Please log in");
    const rejected = expect(outcome).rejects.toBeInstanceOf(SessionStoppedError);
    expect(notified).toEqual(["first", "second"]);
    expect(heldAtNotification).toBe(true);
    expect(canceledAtNotification).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    expect(session.controlHeld).toBe(true);
    await flush();
    expect(events.some((event) => event.type === "takeover.request")).toBe(false);
    lease.finish();
    await flush();
    expect(session.status).toBe("waiting_user");
    expect(session.endTakeover(required(session.pendingTakeover), undefined)).toBe(true);
    await rejected;
  });
  it("does not notify unsubscribed or retired owners and keeps other providers' takeover alive", async () => {
    const { session, generation } = setup();
    const stale = vi.fn();
    session.onControlRequested(generation, stale);
    session.retireBrain(generation);
    expect(() => session.onControlRequested(generation, stale)).toThrow(SessionStoppedError);
    const next = session.beginBrain();
    const remove = session.onControlRequested(next, stale);
    remove();
    remove();
    const outcome = session.takeover("login", "Please log in");
    expect(stale).not.toHaveBeenCalled();
    expect(session.isCurrent(next)).toBe(true);
    await flush();
    expect(session.endTakeover(required(session.pendingTakeover), "Ready")).toBe(true);
    await expect(outcome).resolves.toEqual({ by: "user", note: "Ready" });
  });
  it("keeps control fenced and notifies remaining owners if an observer throws", async () => {
    const { session, generation } = setup();
    const lease = session.admit(generation);
    session.onControlRequested(generation, () => {
      throw new Error("private fixture diagnostic");
    });
    const notified = vi.fn();
    session.onControlRequested(generation, notified);
    const outcome = session.takeover("login", "Please log in");
    expect(notified).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
    expect(() => session.admit(generation)).toThrow(ControlHeldError);
    lease.finish();
    await flush();
    expect(session.endTakeover(required(session.pendingTakeover), undefined)).toBe(true);
    await expect(outcome).resolves.toEqual({ by: "user" });
  });
  it("drains admitted tools before publishing control and keeps a hung tool fenced", async () => {
    const { session, generation, events } = setup();
    const slow = session.admit(generation);
    const takeover = session.admit(generation);
    const outcome = session.takeover("login", "wait", undefined, takeover);
    expect(slow.signal.aborted).toBe(true);
    expect(() => session.admit(generation)).toThrow(ControlHeldError);
    await flush();
    expect(events.some((e) => e.type === "takeover.request")).toBe(false);
    expect(session.endTakeover(required(session.pendingTakeover), "too early")).toBe(false);
    slow.finish();
    await flush();
    expect(events.filter((e) => e.type === "takeover.request")).toHaveLength(1);
    session.endTakeover(required(session.pendingTakeover), undefined);
    expect(await outcome).toEqual({ by: "user" });
    takeover.finish();
  });
  it("Stop ends held control once and never permits a replacement", async () => {
    const { session, generation, events } = setup();
    const lease = session.admit(generation);
    const work = session.takeover("login", "wait", undefined, lease);
    const rejected = expect(work).rejects.toBeDefined();
    await flush();
    session.stop();
    session.stop();
    await rejected;
    expect(events.filter((e) => e.type === "takeover.end").map((e) => e.data.by)).toEqual(["stop"]);
    expect(() => session.beginBrain()).toThrow();
    lease.finish();
  });
  it("cancels an ordinary question on generation loss without clearing taint", async () => {
    const { session, generation, events } = setup();
    session.tainted = true;
    const answer = session.ask("Continue?", ["Yes"], false, 10000, undefined, generation);
    session.retireBrain(generation);
    expect(await answer).toEqual({ by: "stop" });
    expect(session.tainted).toBe(true);
    expect(session.stopped).toBe(false);
    expect(events.filter((e) => e.type === "ask.answer")).toHaveLength(1);
    session.beginBrain();
  });
  it("only a valid real answer clears taint; timeout does not", async () => {
    vi.useFakeTimers();
    const { session, generation } = setup();
    session.tainted = true;
    const first = session.ask("Continue?", ["Yes"], false, 100, undefined, generation);
    expect(session.answer(required(session.pendingAsk), "Z", undefined)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toEqual({ by: "timeout" });
    expect(session.tainted).toBe(true);
    const second = session.ask("Continue?", ["Yes"], false, 100, undefined, generation);
    session.answer(required(session.pendingAsk), "A", undefined);
    expect(await second).toEqual({ by: "user", option: "A" });
    expect(session.tainted).toBe(false);
  });
});

describe("durable inbox acknowledgements", () => {
  it("redelivers before ack, deduplicates after append and retains ordered source IDs", async () => {
    const { session, generation, store, home } = setup();
    const a = session.post("followup", "one");
    const b = session.post("steer", "two");
    await session.inbox(0, 0, undefined, generation);
    expect(session.delivered).toBe(0);
    const messages = [a, b].map((i) => ({
      role: "user" as const,
      content: i.text,
      sourceInbox: { seq: i.seq, messageId: i.messageId },
    }));
    session.appendTranscript(store, generation, { messages });
    expect(store.state(session.id).inboxAfter).toBe(0);
    session.retireBrain(generation);
    const next = session.beginBrain();
    expect((await session.inbox(0, 0, undefined, next)).items).toEqual([a, b]);
    session.appendTranscript(store, next, { messages, inboxAfter: 2 });
    expect(store.read(session.id)).toEqual(messages);
    expect(session.delivered).toBe(2);
    expect(new TranscriptStore(home).state(session.id).inboxAfter).toBe(2);
    expect((await session.inbox(2, 0, undefined, next)).items).toEqual([]);
  });
  it("refuses unseen, future, forged, skipped and stale acknowledgements", async () => {
    const { session, generation, store } = setup();
    const item = session.post("steer", "exact original");
    expect(() =>
      session.appendTranscript(store, generation, { messages: [], inboxAfter: 1 }),
    ).toThrow("unseen");
    await session.inbox(0, 0, undefined, generation);
    expect(() =>
      session.appendTranscript(store, generation, { messages: [], inboxAfter: 1 }),
    ).toThrow("unrecorded");
    expect(() =>
      session.appendTranscript(store, generation, { messages: [], inboxAfter: 2 }),
    ).toThrow("cursor");
    const sourceInbox = { seq: 1, messageId: item.messageId };
    expect(() =>
      session.appendTranscript(store, generation, {
        messages: [{ role: "user", content: "forged", sourceInbox }],
        inboxAfter: 1,
      }),
    ).toThrow("match");
    session.retireBrain(generation);
    session.beginBrain();
    expect(() =>
      session.appendTranscript(store, generation, {
        messages: [{ role: "user", content: item.text, sourceInbox }],
        inboxAfter: 1,
      }),
    ).toThrow();
    expect(store.state(session.id)).toEqual({ messages: [], inboxAfter: 0 });
  });
  it("persists messages before acknowledgement and refuses ack after intervening Stop", async () => {
    const { session, generation, store } = setup();
    const item = session.post("steer", "message");
    await session.inbox(0, 0, undefined, generation);
    const original = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((id, messages) => {
      original(id, messages);
      session.stop();
    });
    expect(() =>
      session.appendTranscript(store, generation, {
        messages: [
          { role: "user", content: item.text, sourceInbox: { seq: 1, messageId: item.messageId } },
        ],
        inboxAfter: 1,
      }),
    ).toThrow();
    expect(store.state(session.id).messages).toHaveLength(1);
    expect(store.state(session.id).inboxAfter).toBe(0);
  });
  it("acknowledges resume controls only after this generation fetched them", async () => {
    const { session, generation, store } = setup();
    session.post("resume", "");
    expect(() =>
      session.appendTranscript(store, generation, { messages: [], inboxAfter: 1 }),
    ).toThrow("unseen");
    await session.inbox(0, 0, undefined, generation);
    session.appendTranscript(store, generation, { messages: [], inboxAfter: 1 });
    expect(store.state(session.id)).toEqual({ messages: [], inboxAfter: 1 });
  });
  it("recovers a torn tail before subsequent records and rejects completed corruption", () => {
    const { session, store, home } = setup();
    store.append(session.id, [{ role: "assistant", content: "first" }]);
    const file = join(home, "sessions", session.id, "transcript.jsonl");
    appendFileSync(file, '{"v":');
    store.append(session.id, [{ role: "assistant", content: "second" }]);
    expect(store.read(session.id).map((m) => m.content)).toEqual(["first", "second"]);
    appendFileSync(file, "{broken}\n");
    expect(() => store.read(session.id)).toThrow("corrupt");
  });
});

it("does not advance delivery after failed message or acknowledgement persistence", async () => {
  const { session, generation, store } = setup();
  const item = session.post("steer", "keep this");
  await session.inbox(0, 0, undefined, generation);
  const request = {
    messages: [
      {
        role: "user" as const,
        content: item.text,
        sourceInbox: { seq: item.seq, messageId: item.messageId },
      },
    ],
    inboxAfter: 1,
  };
  const append = vi.spyOn(store, "append").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  expect(() => session.appendTranscript(store, generation, request)).toThrow("disk full");
  expect(session.delivered).toBe(0);
  expect(store.read(session.id)).toEqual([]);
  append.mockRestore();
  const ack = vi.spyOn(store, "acknowledge").mockImplementationOnce(() => {
    throw new Error("fsync failed");
  });
  expect(() => session.appendTranscript(store, generation, request)).toThrow("fsync failed");
  expect(session.delivered).toBe(0);
  expect(store.read(session.id)).toHaveLength(1);
  ack.mockRestore();
  session.retireBrain(generation);
  const next = session.beginBrain();
  expect((await session.inbox(0, 0, undefined, next)).items).toEqual([item]);
  session.appendTranscript(store, next, request);
  expect(session.delivered).toBe(1);
  expect(store.read(session.id)).toHaveLength(1);
});

it("refuses conflicting durable inbox identity even without acknowledgement", () => {
  const { session, store } = setup();
  const sourceInbox = { seq: 1, messageId: ulid() };
  store.append(session.id, [{ role: "user", content: "original", sourceInbox }]);
  expect(() =>
    store.append(session.id, [{ role: "user", content: "different", sourceInbox }]),
  ).toThrow("conflicting");
  expect(store.read(session.id)).toHaveLength(1);
});

it("drains actual tool settlement rather than treating cancellation as completion", async () => {
  const { session, generation } = setup();
  const lease = session.admit(generation);
  session.retireBrain(generation);
  let drained = false;
  const wait = session.waitForTools().then(() => {
    drained = true;
  });
  await flush();
  expect(lease.signal.aborted).toBe(true);
  expect(drained).toBe(false);
  lease.finish();
  await wait;
  expect(drained).toBe(true);
});

describe("storage failure boundaries", () => {
  it("settles an ordinary ask if cancellation cannot be logged", async () => {
    const session = new AgentSession(ulid(), ulid(), "task", {
      append: (_id, event) => {
        if (event.type === "ask.answer") throw new Error("disk unavailable");
        return event as never;
      },
    });
    const generation = session.beginBrain();
    const asked = session.ask("Continue?", ["Yes"], false, 60_000);
    const rejection = expect(asked).rejects.toThrow("disk unavailable");
    expect(() => session.retireBrain(generation)).not.toThrow();
    await rejection;
    expect(session.pendingAsk).toBeUndefined();
    expect(session.stopped).toBe(false);
  });
  it("does not accept malformed UTF-8 in a complete transcript record", () => {
    const h = setup();
    h.store.append(h.session.id, [{ role: "user", content: "valid" }]);
    appendFileSync(
      join(h.home, "sessions", h.session.id, "transcript.jsonl"),
      Buffer.concat([
        Buffer.from('{"v":1,"kind":"message","message":{"role":"user","content":"'),
        Buffer.from([0xff]),
        Buffer.from('"}}\n'),
      ]),
    );
    expect(() => h.store.read(h.session.id)).toThrow("encoding");
  });
});
