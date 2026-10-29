import { describe, expect, it } from "vitest";
import { downLocalDot, restartLocalDot, startAtLoginLocalDot, upLocalDot } from "./lifecycle.ts";
import { CommandError, LocalApiError } from "./local-dot.ts";
import { fakeLocalDot } from "./testing/fake-local-dot.ts";

const CELL = "01JXYZ00000000000000000001";
const SESSION = "01JXYZ00000000000000000009";

describe("localdot restart", () => {
  it("restarts a running app without its key service and hands out a link", async () => {
    const f = fakeLocalDot({
      routes: {
        "GET /api/app-update": { phase: "idle" },
        "GET /api/cells": [{ id: CELL, state: "ready" }],
        [`GET /api/cells/${CELL}/live`]: { sessionId: SESSION },
      },
    });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls.filter((call) => !call.startsWith("GET"))).toEqual([
      "stop daemon",
      "start",
      "sign in",
    ]);
    const text = f.out.join("\n");
    expect(text).toContain(`A task is running on computer ${CELL}. It stops now`);
    expect(text).toContain("Computers keep running and keep their data.");
    expect(text).toContain("localDot is ready.");
    expect(f.out.at(-1)).toContain("#code=fake");
  });

  it("starts a stopped app", async () => {
    const f = fakeLocalDot({ app: "stopped", daemon: undefined });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.out[0]).toBe("localDot isn't running; starting it.");
    expect(f.calls).toEqual(["stop daemon", "start", "sign in"]);
  });

  it("stops a hung daemon that outlives its service, by its pid, and starts a fresh one", async () => {
    const f = fakeLocalDot({ app: "not-answering", stubborn: true, ignoresTerm: true });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.out[0]).toBe("localDot isn't answering on port 4750; restarting it.");
    expect(f.calls).toEqual([
      "stop daemon",
      "kill SIGTERM 100",
      "kill SIGKILL 100",
      "start",
      "sign in",
    ]);
    expect(f.out.join("\n")).toContain("localDot (process 100) is still running; stopping it.");
  });

  it("clears a lock whose process is now another program", async () => {
    const f = fakeLocalDot({
      app: "stopped",
      daemon: 555,
      commands: { 555: "/usr/bin/vim notes.txt", 200: "/apps/localdot/bin/keyd" },
    });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls).toEqual(["stop daemon", "remove daemon lock", "start", "sign in"]);
    expect(f.calls).not.toContainEqual(expect.stringMatching(/^kill/));
  });

  it("never kills or unlocks a holder it can't identify", async () => {
    const f = fakeLocalDot({ app: "stopped", daemon: 555, commands: {} });
    await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(/Process 555 holds localDot's lock/);
    expect(f.calls).toEqual(["stop daemon"]);
  });

  it("names the program holding the port and leaves it alone", async () => {
    const f = fakeLocalDot({
      app: "not-answering",
      daemon: undefined,
      portHolder: { pid: 777, command: "python3 -m http.server 4750" },
    });
    await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(
      "Port 4750 is in use by python3 -m http.server 4750 (process 777), so localDot can't start.",
    );
    expect(f.calls).not.toContain("start");
    expect(f.calls).not.toContainEqual(expect.stringMatching(/^kill/));
  });

  it("reports a daemon that crashes on start with the end of its log", async () => {
    const f = fakeLocalDot({ app: "stopped", daemon: undefined, answers: false });
    const failure = restartLocalDot(f.l, f.io);
    await expect(failure).rejects.toThrow(CommandError);
    await expect(failure).rejects.toThrow(/didn't answer within 120 seconds[\s\S]*daemon said/);
    expect(f.out).toContain("Waiting for localDot to answer (15 seconds)…");
    expect(f.m.clock).toBeGreaterThanOrEqual(120_000);
    expect(f.m.clock).toBeLessThan(130_000);
  });

  it("restarts a key service that isn't answering too, and says when keys need unlocking", async () => {
    const f = fakeLocalDot({ keyd: "down", keydPid: undefined, keydStarts: "locked" });
    f.m.routes["GET /api/cells"] = [];
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls.filter((call) => !call.startsWith("GET"))).toEqual(["stop", "start", "sign in"]);
    expect(f.out).toContain("Your saved keys are locked. Unlock them with: localdot unlock");
  });

  it("fails clearly when the key service won't answer", async () => {
    const f = fakeLocalDot({ keyd: "down", keydPid: undefined, keydStarts: "down" });
    await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(
      /its key service isn't answering[\s\S]*keyd said something/,
    );
  });

  it("starts Docker Desktop when Docker isn't running, and still finishes", async () => {
    const f = fakeLocalDot({ docker: false });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls).toContain("start docker");
    expect(f.out.join("\n")).toContain("Docker Desktop is starting");
  });

  it("keeps start at login off when it was off", async () => {
    const f = fakeLocalDot({ login: false });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls).toContain("login off");
    expect(f.m.login).toBe(false);
  });

  it("waits while an installer works and while the app installs an update", async () => {
    const installing = fakeLocalDot({ installer: 4242 });
    await expect(restartLocalDot(installing.l, installing.io)).rejects.toThrow(
      "installer process 4242",
    );
    expect(installing.calls).toEqual([]);
    const updating = fakeLocalDot({ routes: { "GET /api/app-update": { phase: "installing" } } });
    await expect(restartLocalDot(updating.l, updating.io)).rejects.toThrow(
      "An update is being installed.",
    );
    expect(updating.calls).not.toContain("stop daemon");
  });

  it("explains missing services, and an app run some other way", async () => {
    const f = fakeLocalDot({ exists: false });
    await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(
      /dev\.localdot\.keyd and dev\.localdot\.daemon\) aren.t set up on this computer, so the localDot running as process 100 was started some other way[\s\S]*rerun the localDot installer/,
    );
    expect(f.calls).toEqual([]);
  });

  it("leaves services that run another data folder alone", async () => {
    const f = fakeLocalDot({ serviceHome: "/private/other/.localdot" });
    await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(
      "dev.localdot.daemon runs the localDot in /private/other/.localdot",
    );
    expect(f.calls).toEqual([]);
  });

  it("restarts a release-managed installation through down and up", async () => {
    const f = fakeLocalDot({ managed: true, routes: { "GET /api/cells": [] } });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls.filter((call) => !call.startsWith("GET"))).toEqual([
      "managed down",
      "managed up",
    ]);
    expect(f.out.at(-1)).toContain("#code=managed");
    const failed = fakeLocalDot({ managed: true, managedDown: 1 });
    expect(await restartLocalDot(failed.l, failed.io)).toBe(1);
    expect(failed.calls).not.toContain("managed up");
  });

  it("goes on when the app can't say what it is doing", async () => {
    const f = fakeLocalDot({
      routes: { "GET /api/app-update": new LocalApiError(500, "broken") },
    });
    expect(await restartLocalDot(f.l, f.io)).toBe(0);
  });
});

describe("localdot up and down on launchd or systemd services", () => {
  it("up leaves a running app alone, even one run from a terminal, and prints a link", async () => {
    const f = fakeLocalDot({ exists: false });
    expect(await upLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls).toEqual(["sign in"]);
  });

  it("up starts a stopped app and waits for one that is still starting", async () => {
    const stopped = fakeLocalDot({ app: "stopped", daemon: undefined });
    expect(await upLocalDot(stopped.l, stopped.io)).toBe(0);
    expect(stopped.calls).toEqual(["start", "sign in"]);
    // Its daemon holds the lock and comes to answer a moment later.
    const starting = fakeLocalDot({ app: "stopped" });
    let polls = 0;
    starting.l.app = async () => (polls++ < 3 ? "stopped" : "running");
    expect(await upLocalDot(starting.l, starting.io)).toBe(0);
    expect(starting.calls).toEqual(["sign in"]);
  });

  it("up restarts an app that isn't answering, and turns on start at login when asked", async () => {
    const f = fakeLocalDot({ app: "not-answering", login: false });
    expect(await upLocalDot(f.l, f.io, { atLogin: true })).toBe(0);
    expect(f.calls).toEqual(["login on", "stop daemon", "start", "sign in"]);
    expect(f.m.login).toBe(true);
  });

  it("down stops both services and the computers", async () => {
    const f = fakeLocalDot({ routes: { "GET /api/cells": [] } });
    expect(await downLocalDot(f.l, f.io)).toBe(0);
    expect(f.calls.filter((call) => !call.startsWith("GET"))).toEqual(["stop", "stop computers"]);
    expect(f.out.at(-1)).toBe("localDot is down. Computer data has been preserved.");
    const unconfirmed = fakeLocalDot({ computersStop: false, app: "stopped", daemon: undefined });
    await expect(downLocalDot(unconfirmed.l, unconfirmed.io)).rejects.toThrow(
      "computers couldn't be confirmed stopped",
    );
  });

  it("start at login reads and changes this dot's services", async () => {
    const f = fakeLocalDot();
    expect(await startAtLoginLocalDot(f.l, "off", f.io)).toBe(0);
    expect(f.out).toEqual(["off"]);
    expect(f.calls).toEqual(["login off"]);
  });
});

it("tells a foreign program on the port from a localDot started by hand", async () => {
  const f = fakeLocalDot({ exists: false, app: "not-answering", daemon: undefined });
  await expect(restartLocalDot(f.l, f.io)).rejects.toThrow(
    "aren't set up on this computer, and another program is using port 4750.",
  );
});
