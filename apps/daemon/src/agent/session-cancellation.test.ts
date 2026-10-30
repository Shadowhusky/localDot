import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentSession, SessionStoppedError } from "./session.ts";

function fixture() {
  return new AgentSession(ulid(), ulid(), "Fixture task", { append: vi.fn() });
}

describe("idle wait cancellation", () => {
  it("rejects an already canceled external wait without ending the session", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    abort.abort(reason);
    await expect(session.waitForUser(15, abort.signal)).rejects.toBe(reason);
    expect(session.stopped).toBe(false);
  });
  it("rejects cancellation of a pending external wait", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    const wait = session.waitForUser(15, abort.signal);
    abort.abort(reason);
    await expect(wait).rejects.toBe(reason);
    expect(session.stopped).toBe(false);
  });
  it("checks external cancellation before an unread message fast path", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    session.post("followup", "Keep this pending");
    abort.abort(reason);
    await expect(session.waitForUser(15, abort.signal)).rejects.toBe(reason);
    expect(session.delivered).toBe(0);
  });
  it("retains the ordinary session Stop result", async () => {
    const session = fixture();
    const wait = session.waitForUser(100);
    session.stop();
    await expect(wait).resolves.toBe(false);
  });
  it("wakes for an ordinary message while an external signal is active", async () => {
    const session = fixture(),
      abort = new AbortController();
    const wait = session.waitForUser(100, abort.signal);
    session.post("followup", "Continue");
    await expect(wait).resolves.toBe(true);
    expect(session.stopped).toBe(false);
  });
});

describe("what Stop gives back", () => {
  // A task whose journal is kept, so what Stop says of each message can be read back.
  function task(text = "Draw a dog") {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const session = new AgentSession(ulid(), ulid(), text, {
      append: (_id, event) => {
        events.push(event as never);
        return undefined as never;
      },
    });
    const said = (text: string) =>
      events.find((event) => event.type === "message.user" && event.data.text === text)?.data
        .messageId as string;
    const delivery = (messageId: string) =>
      events.findLast(
        (event) => event.type === "message.delivery" && event.data.messageId === messageId,
      )?.data;
    return { session, events, said, delivery };
  }

  it("gives back a new task's message dot has not acted on, and what came after it, oldest first", () => {
    const f = task();
    f.session.askTask();
    f.session.post("followup", "Make it brown");
    f.session.setStatus("running");
    f.session.enqueue("Then add a hat");
    expect(f.session.giveBack(null).map((message) => message.text)).toEqual([
      "Draw a dog",
      "Make it brown",
      "Then add a hat",
    ]);
    for (const text of ["Draw a dog", "Make it brown", "Then add a hat"])
      expect(f.delivery(f.said(text))).toEqual({
        messageId: f.said(text),
        state: "withdrawn",
        reason: "stopped",
      });
    expect(f.session.emptied).toBe(true);
  });

  it("keeps what dot has answered in words or acted on, and gives back only what came after", () => {
    const words = task();
    words.session.askTask();
    words.session.append("message.delta", { messageId: ulid(), text: "Sure, " });
    expect(words.session.giveBack(null)).toEqual([]);
    expect(words.delivery(words.said("Draw a dog"))).toBeUndefined();
    expect(words.session.emptied).toBe(false);

    const acted = task();
    const generation = acted.session.beginBrain();
    acted.session.askTask();
    acted.session.admitCall(generation).finish();
    acted.session.post("followup", "Make it brown");
    expect(acted.session.giveBack(null)).toEqual([
      { messageId: acted.said("Make it brown"), text: "Make it brown" },
    ]);
    expect(acted.delivery(acted.said("Draw a dog"))).toBeUndefined();
    expect(acted.session.emptied).toBe(false);
  });

  it("decides against a tool call starting at the same moment: one admitted first keeps the message, none starts after", () => {
    const first = task();
    const early = first.session.beginBrain();
    first.session.askTask();
    const lease = first.session.admitCall(early);
    expect(first.session.giveBack(null)).toEqual([]);
    lease.finish();

    const after = task();
    const late = after.session.beginBrain();
    after.session.askTask();
    expect(after.session.giveBack(null)).toHaveLength(1);
    expect(() => after.session.admitCall(late)).toThrow(SessionStoppedError);
  });

  it("counts dot thinking, or the computer looked at, as no answer", () => {
    const f = task();
    const generation = f.session.beginBrain();
    f.session.askTask();
    f.session.append("thought.delta", { text: "The user wants a dog" });
    f.session.append("message.delta", { messageId: ulid(), text: "  " });
    f.session.admit(generation).finish();
    expect(f.session.giveBack(null).map((message) => message.text)).toEqual(["Draw a dog"]);
  });

  it("gives a shared link back only its own messages, and leaves the owner's unsent", () => {
    const f = task();
    f.session.askTask("link");
    f.session.post("followup", "Owner's words");
    f.session.post("followup", "Guest's words", "link");
    expect(f.session.giveBack("link").map((message) => message.text)).toEqual([
      "Draw a dog",
      "Guest's words",
    ]);
    expect(f.delivery(f.said("Owner's words"))).toMatchObject({
      state: "cancelled",
      reason: "stopped",
    });
    expect(f.session.emptied).toBe(false);
    // Asked again it answers the same; anyone else gets nothing.
    expect(f.session.giveBack("link")).toHaveLength(2);
    expect(f.session.giveBack(null)).toEqual([]);
  });

  it("leaves unanswered messages unsent for an Edit when Stop gives nothing back, and said when the task ends otherwise", () => {
    const stopped = task();
    stopped.session.askTask();
    stopped.session.cancel();
    expect(stopped.delivery(stopped.said("Draw a dog"))).toMatchObject({
      state: "cancelled",
      reason: "stopped",
    });
    expect(stopped.session.giveBack(null)).toEqual([]);

    const failed = task();
    failed.session.askTask();
    failed.session.cancel("error");
    expect(failed.delivery(failed.said("Draw a dog"))).toBeUndefined();
  });
});
