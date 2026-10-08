// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_GAP, createAnnouncer } from "./Announcer.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetModules();
});

describe("announcer", () => {
  it("speaks at once, then holds the next until the gap has passed", () => {
    const queue = createAnnouncer();
    queue.announce("status", "Working");
    expect(queue.spoken().polite).toBe("Working");
    vi.advanceTimersByTime(500);
    queue.announce("toast a", "Saved to Downloads");
    expect(queue.spoken().polite).toBe("Working");
    vi.advanceTimersByTime(ANNOUNCE_GAP - 501);
    expect(queue.spoken().polite).toBe("Working");
    vi.advanceTimersByTime(1);
    expect(queue.spoken().polite).toBe("Saved to Downloads");
  });

  it("lets a newer message on a channel replace one still waiting there", () => {
    const queue = createAnnouncer();
    queue.announce("status", "Working");
    queue.announce("status", "Needs you");
    queue.announce("status", "Paused");
    vi.advanceTimersByTime(ANNOUNCE_GAP);
    expect(queue.spoken().polite).toBe("Paused");
    vi.advanceTimersByTime(ANNOUNCE_GAP * 3);
    expect(queue.spoken().polite).toBe("Paused");
  });

  it("gives each channel its turn in order, one per gap", () => {
    const queue = createAnnouncer();
    const heard: string[] = [];
    queue.subscribe(() => heard.push(queue.spoken().polite));
    queue.announce("status", "Working");
    queue.announce("toast a", "Saved to Downloads");
    queue.announce("toast b", "Key moved to Keys");
    vi.advanceTimersByTime(ANNOUNCE_GAP * 2);
    expect(heard).toEqual(["Working", "Saved to Downloads", "Key moved to Keys"]);
  });

  it("never holds back an error that stops work", () => {
    const queue = createAnnouncer();
    queue.announce("status", "Working");
    queue.announce("stop", "Couldn't stop the task", "assertive");
    expect(queue.spoken()).toEqual({ polite: "Working", assertive: "Couldn't stop the task" });
  });

  it("changes the region's text when the same words come again, so they are heard again", () => {
    const queue = createAnnouncer();
    queue.announce("toast a", "Saved to Downloads");
    vi.advanceTimersByTime(ANNOUNCE_GAP);
    queue.announce("toast b", "Saved to Downloads");
    const again = queue.spoken().polite;
    expect(again).not.toBe("Saved to Downloads");
    expect(again.trim()).toBe("Saved to Downloads");
  });

  it("renders the page's one polite region and one alert region", async () => {
    const { Announcer, announce } = await import("./Announcer.tsx");
    render(<Announcer />);
    act(() => announce("status", "Needs you"));
    expect(screen.getByRole("status")).toHaveProperty("textContent", "Needs you");
    act(() => announce("stop", "Couldn't stop the task", "assertive"));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "Couldn't stop the task");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(2);
  });
});
