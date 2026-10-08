import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToasts, SHOWN_FOR } from "./toasts.ts";

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

describe("toast queue", () => {
  it("puts the newest in front", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    queue.show({ title: "Key moved to Keys" });
    expect(shown(queue)).toEqual(["Key moved to Keys", "Saved to Downloads"]);
  });

  it("gives the front toast its time, then the one behind it its own", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    vi.advanceTimersByTime(1000);
    queue.show({ title: "Key moved to Keys" });
    vi.advanceTimersByTime(SHOWN_FOR - 1);
    expect(shown(queue)).toEqual(["Key moved to Keys", "Saved to Downloads"]);
    vi.advanceTimersByTime(1);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    // It had been in front for 1 s before the newer one came, so 3 s are left.
    vi.advanceTimersByTime(SHOWN_FOR - 1001);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    vi.advanceTimersByTime(1);
    expect(shown(queue)).toEqual([]);
  });

  it("keeps a failure until it is dismissed", () => {
    const queue = createToasts();
    const id = queue.show({ title: "Couldn't confirm the stop", tone: "danger" });
    vi.advanceTimersByTime(SHOWN_FOR * 10);
    expect(shown(queue)).toEqual(["Couldn't confirm the stop"]);
    queue.dismiss(id);
    expect(shown(queue)).toEqual([]);
  });

  it("stands the front toast's time still while held, and goes on from there", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    vi.advanceTimersByTime(3000);
    queue.hold("hover", true);
    vi.advanceTimersByTime(SHOWN_FOR * 5);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    queue.hold("hover", false);
    vi.advanceTimersByTime(999);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
    vi.advanceTimersByTime(1);
    expect(shown(queue)).toEqual([]);
  });

  it("holds while any reason holds", () => {
    const queue = createToasts();
    queue.show({ title: "Saved to Downloads" });
    queue.hold("hover", true);
    queue.hold("hidden", true);
    queue.hold("hover", false);
    vi.advanceTimersByTime(SHOWN_FOR * 2);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
  });

  it("replaces a toast shown again under its id, brings it forward and restarts its time", () => {
    const queue = createToasts();
    queue.show({ id: "stop", title: "Couldn't confirm the stop", tone: "danger" });
    queue.show({ title: "Saved to Downloads" });
    queue.show({ id: "stop", title: "Stopped", tone: "success" });
    expect(shown(queue)).toEqual(["Stopped", "Saved to Downloads"]);
    expect(queue.list().filter((toast) => toast.id === "stop")).toHaveLength(1);
    vi.advanceTimersByTime(SHOWN_FOR);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
  });

  it("keeps a toast's key when it is shown again in place, and gives it a new one after a swipe", () => {
    const queue = createToasts();
    queue.show({ id: "stop", title: "Couldn't confirm the stop", tone: "danger" });
    const first = queue.list()[0]?.key;
    queue.show({ id: "stop", title: "Still checking", tone: "danger" });
    queue.dismiss("stop");
    queue.show({ id: "stop", title: "Stopped", tone: "success" });
    expect(queue.list().map((toast) => toast.key)).toEqual([first]);
    // Its element is still flying off with the swipe, so the toast comes back as a new one.
    queue.dismiss("stop", "swipe");
    queue.show({ id: "stop", title: "Couldn't confirm the stop", tone: "danger" });
    expect(queue.list()).toHaveLength(1);
    expect(shown(queue)).toEqual(["Couldn't confirm the stop"]);
    expect(queue.list()[0]?.key).not.toBe(first);
  });

  it("keeps a dismissed toast listed as leaving until it is forgotten", () => {
    const queue = createToasts();
    const id = queue.show({ title: "Saved to Downloads" });
    queue.dismiss(id, "swipe");
    expect(queue.list()).toEqual([expect.objectContaining({ id, leaving: "swipe" })]);
    queue.forget(id);
    expect(queue.list()).toEqual([]);
  });

  it("does not forget a toast that is still on show", () => {
    const queue = createToasts();
    const id = queue.show({ title: "Saved to Downloads" });
    queue.forget(id);
    expect(shown(queue)).toEqual(["Saved to Downloads"]);
  });
});
