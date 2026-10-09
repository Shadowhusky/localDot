import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToasts,
  REPEAT_MS,
  SETTLE_MS,
  SHOWN_AT_LEAST,
  SHOWN_AT_MOST,
  SHOWN_FOR,
} from "./toasts.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function shown(queue: ReturnType<typeof createToasts>): string[] {
  return queue
    .list()
    .filter((toast) => !toast.leaving)
    .map((toast) => toast.title);
}
const wait = (ms: number) => vi.advanceTimersByTime(ms);

describe("toast queue", () => {
  it("shows one at a time, in the order they came, each once it has settled", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    queue.show({ title: "Key moved to Keys" });
    wait(SETTLE_MS - 1);
    expect(shown(queue)).toEqual([]);
    wait(1);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    // With another waiting, the one on screen goes once it has had its least time.
    wait(SHOWN_AT_LEAST - 1);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    wait(1);
    expect(shown(queue)).toEqual(["Key moved to Keys"]);
    wait(SHOWN_FOR - 1);
    expect(shown(queue)).toEqual(["Key moved to Keys"]);
    wait(1);
    expect(shown(queue)).toEqual([]);
  });

  it("shows nothing for a state that flips back before it settles", () => {
    const queue = createToasts();
    queue.show({ id: "connection", title: "Reconnecting…" });
    wait(SETTLE_MS - 100);
    queue.withdraw("connection");
    wait(SHOWN_AT_MOST);
    expect(queue.list()).toEqual([]);
  });

  it("keeps a toast whose state passed on screen for its least time", () => {
    const queue = createToasts();
    queue.show({ id: "connection", title: "Reconnecting…" });
    wait(SETTLE_MS + 200);
    queue.withdraw("connection");
    wait(SHOWN_AT_LEAST - 201);
    expect(shown(queue)).toEqual(["Reconnecting…"]);
    wait(1);
    expect(shown(queue)).toEqual([]);
  });

  it("never shows the same message again within five seconds of it leaving", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    queue.show({ title: "Saved to Downloads" });
    wait(SHOWN_FOR);
    expect(shown(queue)).toEqual([]);
    queue.show({ title: "Saved to Downloads" });
    wait(REPEAT_MS - 1);
    queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    expect(shown(queue)).toEqual([]);
    // Five seconds on, it may come back.
    queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
  });

  it("lets a result go after four seconds and a failure after six", () => {
    const queue = createToasts();
    queue.show({ title: "Couldn't confirm the stop", tone: "danger" });
    wait(SETTLE_MS + SHOWN_AT_MOST - 1);
    expect(shown(queue)).toEqual(["Couldn't confirm the stop"]);
    wait(1);
    expect(shown(queue)).toEqual([]);
  });

  it("keeps one with an action until it is dismissed, unless another waits for six seconds", () => {
    const queue = createToasts();
    const undo = { label: "Undo", onAction() {} };
    queue.show({ title: "Key moved to Keys", action: undo });
    wait(SETTLE_MS + 60_000);
    expect(shown(queue)).toEqual(["Key moved to Keys"]);
    queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);

    const other = createToasts();
    other.show({ title: "Key moved to Keys", action: undo });
    wait(SETTLE_MS + 1000);
    other.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    expect(shown(other)).toEqual(["Key moved to Keys"]);
    wait(SHOWN_AT_MOST - 1000 - SETTLE_MS);
    expect(shown(other)).toEqual(["Saved to Downloads"]);
  });

  it("stands the time still while held, and goes on from there", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS + 3000);
    queue.hold("hover", true);
    queue.hold("hidden", true);
    queue.hold("hover", false);
    wait(SHOWN_FOR * 5);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    queue.hold("hidden", false);
    wait(999);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    wait(1);
    expect(shown(queue)).toEqual([]);
  });

  it("changes the toast on screen in place under its id and gives it its time again", () => {
    const queue = createToasts();
    queue.show({ id: "stop", title: "Couldn't confirm the stop", tone: "danger" });
    wait(SETTLE_MS + 5000);
    const key = queue.list()[0]?.key;
    queue.show({ id: "stop", title: "Stopped", tone: "success" });
    expect(queue.list()).toEqual([expect.objectContaining({ key, title: "Stopped" })]);
    wait(SHOWN_FOR - 1);
    expect(shown(queue)).toEqual(["Stopped"]);
    wait(1);
    expect(shown(queue)).toEqual([]);
  });

  it("lets the user send the toast away at once and brings the next forward", () => {
    const queue = createToasts();
    const id = queue.show({ title: "Saved to Downloads" });
    queue.show({ title: "Key moved to Keys" });
    wait(SETTLE_MS);
    queue.dismiss(id, "swipe");
    expect(queue.list()).toEqual([
      expect.objectContaining({ title: "Key moved to Keys" }),
      expect.objectContaining({ id, leaving: "swipe" }),
    ]);
    queue.forget(id);
    expect(queue.list()).toEqual([expect.objectContaining({ title: "Key moved to Keys" })]);
  });

  it("does not forget a toast that is still on show", () => {
    const queue = createToasts();
    const id = queue.show({ title: "Saved to Downloads" });
    wait(SETTLE_MS);
    queue.forget(id);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
  });
});
