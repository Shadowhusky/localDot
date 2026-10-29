import { describe, expect, it } from "vitest";
import { runStatus } from "./status.ts";
import { fakeLocalDot, HOME } from "./testing/fake-local-dot.ts";

const CELL = "01JXYZ00000000000000000001";
const OTHER = "01JXYZ00000000000000000002";

const routes = {
  "GET /api/app-update": {
    supported: true,
    currentVersion: "0.1.0-rc.33",
    phase: "idle",
    availableVersion: "0.1.0-rc.34",
    error: null,
  },
  "GET /api/cells": [
    { id: CELL, state: "ready" },
    { id: OTHER, state: "stopped", updateAvailable: true },
  ],
  [`GET /api/cells/${CELL}/live`]: { sessionId: "01JXYZ00000000000000000009" },
  "GET /api/remote-access": { supported: true, enabled: false, state: "off", url: null },
  "GET /api/access-links": {
    links: [],
    tailscale: { state: "served", origin: "https://studio.example.ts.net:4750", message: "On" },
  },
};

describe("localdot status", () => {
  it("shows the app, its services, computers, task, remote access and updates", async () => {
    const f = fakeLocalDot({ routes, keyd: "locked", login: false });
    expect(await runStatus(f.l, f.io, { json: false, version: "development" })).toBe(0);
    expect(f.out).toEqual([
      "localDot 0.1.0-rc.33 is running at http://127.0.0.1:4750 (process 100).",
      `  Data folder    ${HOME}`,
      "  Services       dev.localdot.daemon and dev.localdot.keyd (launchd); start at login off",
      "  Key service    running; saved keys locked (localdot unlock)",
      "  Docker         running",
      `  Computers      ${CELL}  ready, a task is running`,
      `                 ${OTHER}  stopped, update available`,
      "  Remote access  off (turn on: localdot remote on)",
      "  Tailscale      on at https://studio.example.ts.net:4750",
      "  Updates        0.1.0-rc.34 is available (Settings › Updates, or localdot update)",
    ]);
  });

  it("reports a stopped app with the step that starts it, and exits 1", async () => {
    const f = fakeLocalDot({
      app: "stopped",
      daemon: undefined,
      keyd: "down",
      docker: false,
      exists: false,
    });
    expect(await runStatus(f.l, f.io, { json: false, version: "1.2.3" })).toBe(1);
    expect(f.out[0]).toBe("localDot isn't running. Start it with: localdot up");
    expect(f.out.join("\n")).toContain("not set up (dev.localdot.daemon and dev.localdot.keyd)");
    expect(f.out.join("\n")).toContain("Key service  not answering");
    expect(f.calls).toEqual([]);
  });

  it("gives the same facts as JSON", async () => {
    const f = fakeLocalDot({ routes });
    expect(await runStatus(f.l, f.io, { json: true, version: "development" })).toBe(0);
    const report = JSON.parse(f.out[0] ?? "");
    expect(report).toMatchObject({
      version: "0.1.0-rc.33",
      app: "running",
      pid: 100,
      install: "services",
      keyd: "ready",
      docker: "running",
      services: { manager: "launchd", installed: true, startAtLogin: true },
      remoteAccess: { enabled: false },
      tailscale: { state: "served" },
      update: { availableVersion: "0.1.0-rc.34" },
    });
    expect(report.computers).toHaveLength(2);
    expect(report.computers[0].task).toBe("01JXYZ00000000000000000009");
    const hung = fakeLocalDot({ app: "not-answering" });
    expect(await runStatus(hung.l, hung.io, { json: true, version: "1.2.3" })).toBe(1);
    expect(JSON.parse(hung.out[0] ?? "")).toMatchObject({ app: "not-answering", computers: null });
  });
});

it("says when this computer's services run another data folder", async () => {
  const f = fakeLocalDot({
    serviceHome: "/private/other/.localdot",
    app: "stopped",
    daemon: undefined,
  });
  expect(await runStatus(f.l, f.io, { json: false, version: "1.2.3" })).toBe(1);
  expect(f.out).toContain(
    "  Services     dev.localdot.daemon runs /private/other/.localdot, not this folder",
  );
});
