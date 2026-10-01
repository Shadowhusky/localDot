import { describe, expect, it } from "vitest";
import { hudFor } from "./hud-state.ts";
import type { CellSummary } from "./types.ts";

const cell = (
  state: CellSummary["state"],
  connection: CellSummary["stream"]["connection"] = "none",
  error?: string,
): CellSummary => ({
  id: "01JXYZ0000000000000000ABCD",
  state,
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection, viewers: 0, lastUpstreamAt: null },
  ...(error ? { error } : {}),
});

describe("hudFor", () => {
  it("offers to start when there is no computer or it is stopped or failed", () => {
    expect(hudFor(null, false)).toMatchObject({
      label: "No computer",
      action: "start",
      live: false,
    });
    expect(hudFor(cell("stopped"), false)).toMatchObject({ label: "Stopped", action: "start" });
    expect(
      hudFor(cell("failed", "none", "desktop container exited with 137"), false),
    ).toMatchObject({
      label: "Failed",
      caption: "desktop container exited with 137",
      action: "start",
    });
  });

  it("shows progress without an action while starting, stopping or busy", () => {
    expect(hudFor(cell("starting"), false)).toMatchObject({ label: "Starting…", action: "none" });
    expect(hudFor(cell("stopping"), false)).toMatchObject({ label: "Stopping…", action: "none" });
    expect(hudFor(null, true)).toMatchObject({ action: "none" });
  });

  it("reflects the stream once the computer is ready", () => {
    expect(hudFor(cell("ready", "live"), false)).toMatchObject({
      label: "Live",
      action: "stop",
      live: true,
    });
    expect(hudFor(cell("ready", "connecting"), false)).toMatchObject({
      label: "Connecting…",
      live: false,
    });
    expect(hudFor(cell("ready", "stalled"), false)).toMatchObject({
      label: "Reconnecting…",
      live: false,
    });
    expect(hudFor(cell("ready", "disconnected"), false)).toMatchObject({
      label: "Reconnecting…",
      action: "stop",
    });
  });

  it("shows a crash restart as reconnecting, with the orchestrator's note", () => {
    const note = "desktop container exited with 137; restarting (attempt 2 of 5)";
    expect(hudFor(cell("starting", "none", note), false)).toEqual({
      label: "Reconnecting…",
      caption: note,
      action: "stop",
      live: false,
    });
    expect(hudFor(cell("starting", "none", note), true).action).toBe("none");
  });
});
