import { describe, expect, it } from "vitest";
import { type CellView, type ComputerPhase, hudFor, NEEDS_FRESH_START } from "./hud-state.ts";
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

const known = (c: CellSummary | null, pending: CellView["pending"] = null): CellView => ({
  cell: c,
  status: "known",
  pending,
});

// Real orchestrator errors (apps/daemon/src/cells/orchestrator.ts) and a real DockerError body.
const DOCKER_DOWN = "docker unreachable on /networks/create: ENOENT; is Docker Desktop running?";
const RESTART_NOTE = "desktop container exited with 137; restarting (attempt 2 of 5)";

describe("hudFor", () => {
  it("reads this viewer's picture beside the daemon's stream state", () => {
    const phase = (
      connection: CellSummary["stream"]["connection"],
      picture?: "none" | "live" | "held",
    ) => hudFor({ ...known(cell("ready", connection)), picture }).phase;
    // Another viewer keeps the daemon's stream live while this one's client reconnects.
    expect(phase("live", "held")).toBe("reconnecting");
    // This viewer's relay reconnecting: it keeps its picture instead of raising the curtain.
    expect(phase("connecting", "held")).toBe("reconnecting");
    expect(phase("none", "held")).toBe("reconnecting");
    // Frames already shown while the daemon's state catches up.
    expect(phase("connecting", "live")).toBe("live");
    expect(phase("stalled", "live")).toBe("reconnecting");
    expect(phase("connecting", "none")).toBe("connecting");
    expect(phase("connecting")).toBe("connecting");
    expect(phase("live")).toBe("live");
  });

  it("keeps frozen computers paused regardless of stream state, with pending controls disabled", () => {
    for (const connection of ["none", "connecting", "live", "stalled", "disconnected"] as const) {
      const paused = { ...cell("ready", connection), paused: true as const };
      const hud = hudFor(known(paused));
      expect(hud).toMatchObject({
        label: "Paused",
        action: { kind: "resume", enabled: true },
        live: false,
      });
      expect(hud.caption).toBe(
        "Your computer is paused. Resume it to carry on, or shut it down for a fresh start.",
      );
      expect(hudFor(known(paused, "resume")).action).toEqual({ kind: "resume", enabled: false });
      expect(hudFor(known(paused, "stop")).action.enabled).toBe(false);
    }
  });

  it("offers to start when there is no computer or it is stopped", () => {
    expect(hudFor(known(null))).toMatchObject({
      label: "No computer",
      action: { kind: "start", enabled: true },
      live: false,
    });
    expect(hudFor(known(cell("stopped")))).toMatchObject({
      label: "Stopped",
      action: { kind: "start", enabled: true },
    });
  });

  it("says it is checking while the first list is out, without offering a usable control", () => {
    expect(hudFor({ cell: null, status: "listing", pending: "list" })).toMatchObject({
      label: "Checking…",
      action: { enabled: false },
    });
  });

  it("does not claim there is no computer when the list failed, and offers to try again", () => {
    const hud = hudFor({ cell: null, status: "unknown", pending: null });
    expect(hud.label).not.toBe("No computer");
    expect(hud).toMatchObject({ label: "Unavailable", action: { kind: "retry", enabled: true } });
    expect(hudFor({ cell: null, status: "unknown", pending: "list" }).action).toEqual({
      kind: "retry",
      enabled: false,
    });
  });

  it("says Starting… while the computer is being created", () => {
    expect(hudFor(known(null, "create"))).toMatchObject({
      label: "Starting…",
      action: { kind: "stop", enabled: false },
    });
  });

  it("offers Stop while starting, and disables the control while a request is out", () => {
    expect(hudFor(known(cell("starting")))).toMatchObject({
      label: "Starting…",
      action: { kind: "stop", enabled: true },
    });
    expect(hudFor(known(cell("starting"), "start")).action).toEqual({
      kind: "stop",
      enabled: false,
    });
    expect(hudFor(known(cell("stopping")))).toMatchObject({
      label: "Stopping…",
      action: { kind: "start", enabled: false },
    });
  });

  it("shows a failure in plain words and offers Turn on, or Stop again when the stop failed", () => {
    const failed = hudFor(known(cell("failed", "none", `not ready after 120 s: ${DOCKER_DOWN}`)));
    expect(failed).toMatchObject({ label: "Failed", action: { kind: "start", enabled: true } });
    expect(failed.caption).toBe("Your computer didn't finish starting. Turn it on again.");
    const stopFailed = hudFor(known(cell("failed", "none", `stop failed: ${DOCKER_DOWN}`)));
    expect(stopFailed).toMatchObject({ label: "Failed", action: { kind: "stop", enabled: true } });
    expect(stopFailed.caption).toBe(
      "Your computer didn't stop: Docker isn't answering. Check that Docker Desktop is running, then stop it again.",
    );
  });

  it("asks to turn the computer on again, naming the Turn on control", () => {
    for (const error of [
      DOCKER_DOWN,
      `not ready after 120 s: ${DOCKER_DOWN}`,
      "desktop container exited with 1; stop and start the computer",
      "desktop container exited with 137; gave up after 5 restarts",
      "background check stopped (EACCES)",
    ]) {
      const failed = hudFor(known(cell("failed", "none", error)));
      expect(failed.action, error).toEqual({ kind: "start", enabled: true });
      expect(failed.caption, error).toMatch(/turn it on again|turn on your computer again/i);
      expect(failed.caption, error).not.toMatch(/\bstart\b/i);
    }
  });

  it("keeps Docker's and the daemon's own wording out of every caption", () => {
    const errors = [
      DOCKER_DOWN,
      `stop failed: ${DOCKER_DOWN}`,
      `not ready after 120 s: desktopd not ready: hidpi {"ok":false}, screen null`,
      "desktop container exited with 1; stop and start the computer",
      "gate container is missing: removed outside localDot",
      "containers missing: removed outside localDot",
      "desktop container exited with 137; gave up after 5 restarts",
      "background check stopped (EACCES)",
      "something new the daemon says",
    ];
    for (const error of errors) {
      const { caption } = hudFor(known(cell("failed", "none", error)));
      expect(caption, error).not.toMatch(/docker unreachable|ENOENT|desktopd|hidpi|EACCES|says/);
      expect(caption.length, error).toBeGreaterThan(0);
    }
  });

  it("reflects the stream once the computer is ready", () => {
    expect(hudFor(known(cell("ready", "live")))).toMatchObject({
      label: "Ready",
      action: { kind: "stop", enabled: true },
      live: true,
    });
    expect(hudFor(known(cell("ready", "connecting")))).toMatchObject({
      label: "Connecting…",
      live: false,
    });
    expect(hudFor(known(cell("ready", "stalled")))).toMatchObject({
      label: "Reconnecting…",
      live: false,
    });
    expect(hudFor(known(cell("ready", "disconnected")))).toMatchObject({
      label: "Reconnecting…",
      action: { kind: "stop", enabled: true },
    });
    expect(hudFor(known(cell("ready", "live"), "stop")).action.enabled).toBe(false);
  });

  it("shows a crash restart as reconnecting, with the attempt from the orchestrator's note", () => {
    expect(hudFor(known(cell("starting", "none", RESTART_NOTE)))).toEqual({
      phase: "restarting",
      label: "Reconnecting…",
      caption: "Your computer stopped unexpectedly. Restarting it (attempt 2 of 5).",
      action: { kind: "stop", enabled: true },
      live: false,
    });
    expect(hudFor(known(cell("starting", "none", RESTART_NOTE), "stop")).action.enabled).toBe(
      false,
    );
  });

  it("names the computer's phase on every branch, live only when the stream is", () => {
    const paused = { paused: true as const };
    const cases: [CellView, ComputerPhase][] = [
      [{ cell: null, status: "listing", pending: "list" }, "checking"],
      [{ cell: null, status: "unknown", pending: null }, "unavailable"],
      [known(cell("ready", "live"), "list"), "checking"],
      [known({ ...cell("ready", "live"), ...paused }, "list"), "frozen"],
      [known(null, "create"), "starting"],
      [known(null), "none"],
      [known({ ...cell("ready", "live"), fenced: { revision: 1 } }), "unavailable"],
      [known({ ...cell("ready", "live"), replacementPending: true }), "starting"],
      [known({ ...cell("starting"), ...paused }), "frozen"],
      [known(cell("starting", "none", RESTART_NOTE)), "restarting"],
      [known(cell("starting")), "starting"],
      [known(cell("stopping")), "stopping"],
      [known(cell("stopped")), "stopped"],
      [known(cell("removed")), "stopped"],
      [known(cell("failed", "none", DOCKER_DOWN)), "failed"],
      [known({ ...cell("ready", "live"), ...paused }), "frozen"],
      [known(cell("ready", "live")), "live"],
      [known(cell("ready", "stalled")), "reconnecting"],
      [known(cell("ready", "disconnected")), "reconnecting"],
      [known(cell("ready", "connecting")), "connecting"],
      [known(cell("ready", "none")), "connecting"],
    ];
    for (const [view, phase] of cases) {
      const hud = hudFor(view);
      expect(hud.phase, hud.label).toBe(phase);
      expect(hud.live, hud.label).toBe(phase === "live");
    }
  });

  it("shows an update's stop and start as one waking step that offers no control", () => {
    for (const state of ["stopping", "starting"] as const) {
      expect(hudFor(known({ ...cell(state), updating: true }))).toMatchObject({
        phase: "starting",
        label: "Updating…",
        action: { kind: "stop", enabled: false },
      });
    }
    const unfinished = cell(
      "failed",
      "none",
      "The update didn't finish. Turn on your computer to finish it.",
    );
    expect(hudFor(known(unfinished))).toMatchObject({
      phase: "failed",
      caption: "The update didn't finish. Turn on your computer to finish it.",
      action: { kind: "start", enabled: true },
    });
    const unreadable =
      "localDot can't read its update records. Restart localDot, then turn on your computer.";
    expect(hudFor(known(cell("failed", "none", unreadable))).caption).toBe(unreadable);
  });

  it("names Start fresh when an update can't be finished, whatever the daemon's words", () => {
    const refused = "Your computer's update can't be finished. Start fresh to use it again.";
    for (const state of ["failed", "stopped"] as const) {
      const hud = hudFor(known({ ...cell(state, "none", refused), needsFreshStart: true }));
      expect(hud).toMatchObject({
        phase: "failed",
        caption: NEEDS_FRESH_START,
        action: { kind: "start", enabled: true },
      });
    }
    expect(NEEDS_FRESH_START).toMatch(/Start fresh/);
    // Without the mark, the same words read as an ordinary failure to start.
    expect(hudFor(known(cell("failed", "none", refused))).caption).toBe(
      "Your computer could not start.",
    );
    // A fenced computer still recovers through Replace computer.
    expect(
      hudFor(known({ ...cell("ready"), fenced: { revision: 1 }, needsFreshStart: true })).phase,
    ).toBe("unavailable");
  });
});
