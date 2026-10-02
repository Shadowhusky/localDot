import { describe, expect, it } from "vitest";
import type { LeaseRequest } from "../protocol/browserd.ts";
import { ScreenControl } from "./screen-control.ts";
import { ScreenBusyError, ScreenSwitcher } from "./screen-switcher.ts";

const DESKTOP = "01J9ZQ3V8Y7X6W5T4S3R2Q1D00";
const BROWSER = "01J9ZQ3V8Y7X6W5T4S3R2Q1B00";
const GEOMETRY = { w: 2560, h: 1600, scale: 2 } as const;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function rig(opts: { browserReady?: Promise<void>; failHandBack?: { now: boolean } } = {}) {
  const log: string[] = [];
  let n = 0;
  const control = new ScreenControl({
    browserd: {
      setLease: async (cellId: string, req: LeaseRequest) => {
        log.push(`browserd ${req.holder}`);
        if (opts.failHandBack?.now && req.holder === "agent") throw new Error("reload failed");
        return { holder: req.holder, leaseId: req.leaseId, reloaded: 0, selectionsCleared: req.holder === "agent" };
      },
    },
    isBrowserCell: (id) => id === BROWSER,
    ulid: () => `01J9ZQ3V8Y7X6W5T4S3R2Q${String(++n).padStart(4, "0")}`,
  });
  control.subscribe((cellId, holder) => log.push(`${cellId === BROWSER ? "browser" : "desktop"} input ${holder === "user" ? "open" : "closed"}`));
  const switcher = new ScreenSwitcher({
    ensureBrowser: async () => {
      log.push("browser starting");
      await (opts.browserReady ?? Promise.resolve());
      log.push("browser ready");
      return { cellId: BROWSER };
    },
    geometryOf: () => GEOMETRY,
    control,
    append: (_s, type, data) => log.push(`${type} ${data.screen}`),
  });
  const abort = new AbortController();
  const session = { id: "S1", cellId: DESKTOP, signal: abort.signal };
  return { log, control, switcher, session, abort };
}

describe("switch_screen against a takeover (Review Focus 4)", () => {
  it("a takeover asked for during a switch waits for it, then hands the user the new screen", async () => {
    const ready = deferred();
    const r = rig({ browserReady: ready.promise });
    const switching = r.switcher.switchTo(r.session, "browser");
    const takeover = r.switcher.beginTakeover(r.session);
    await Promise.resolve();
    expect(r.log).toEqual(["browser starting"]);
    ready.resolve();
    expect(await switching).toMatchObject({ screen: "browser", changed: true });
    expect(await takeover).toEqual({ screen: "browser", cellId: BROWSER });
    expect(r.log).toEqual([
      "browser starting",
      "browser ready",
      "browser input closed",
      "browserd agent",
      "screen.switch browser",
      "browserd user",
      "browser input open",
    ]);
    expect(r.control.holder(BROWSER)).toBe("user");
    expect(r.control.holder(DESKTOP)).toBe("agent");
  });

  it("refuses a switch while the user has control, and changes nothing", async () => {
    const r = rig();
    await r.switcher.beginTakeover(r.session);
    await expect(r.switcher.switchTo(r.session, "browser")).rejects.toBeInstanceOf(ScreenBusyError);
    expect(r.switcher.active(r.session).screen).toBe("desktop");
    expect(r.log.filter((l) => l.startsWith("screen.switch"))).toEqual([]);
    expect(r.switcher.userHolds("S1")).toBe(true);
  });

  it("locks the agent out at browserd before the viewer's input opens, and closes the input before the agent is let back", async () => {
    const r = rig();
    await r.switcher.switchTo(r.session, "browser");
    r.log.length = 0;
    await r.switcher.beginTakeover(r.session);
    expect(r.log).toEqual(["browserd user", "browser input open"]);
    r.log.length = 0;
    await r.switcher.endTakeover(r.session);
    expect(r.log).toEqual(["browser input closed", "browserd agent"]);
    expect(r.switcher.userHolds("S1")).toBe(false);
  });

  it("a switch asked for during the hand-back runs after it", async () => {
    const r = rig();
    await r.switcher.switchTo(r.session, "browser");
    await r.switcher.beginTakeover(r.session);
    r.log.length = 0;
    const back = r.switcher.endTakeover(r.session);
    const toDesktop = r.switcher.switchTo(r.session, "desktop");
    await Promise.all([back, toDesktop]);
    expect(r.log).toEqual(["browser input closed", "browserd agent", "screen.switch desktop"]);
  });

  it("a hand-back that cannot reload the page leaves the user holding the screen and the agent out", async () => {
    const fail = { now: false };
    const r = rig({ failHandBack: fail });
    await r.switcher.switchTo(r.session, "browser");
    await r.switcher.beginTakeover(r.session);
    fail.now = true;
    await expect(r.switcher.endTakeover(r.session)).rejects.toThrow(/reload failed/);
    expect(r.switcher.userHolds("S1")).toBe(true);
    await expect(r.switcher.switchTo(r.session, "desktop")).rejects.toBeInstanceOf(ScreenBusyError);
    fail.now = false;
    await r.switcher.endTakeover(r.session);
    expect(r.switcher.userHolds("S1")).toBe(false);
  });

  it("Stop during a switch ends it before the screen changes", async () => {
    const ready = deferred();
    const r = rig({ browserReady: ready.promise });
    const switching = r.switcher.switchTo(r.session, "browser");
    r.abort.abort();
    ready.resolve();
    await expect(switching).rejects.toThrow();
    expect(r.switcher.active(r.session).screen).toBe("desktop");
    expect(r.log.filter((l) => l.startsWith("screen.switch"))).toEqual([]);
  });

  it("two switches run in the order they were asked", async () => {
    const r = rig();
    await Promise.all([r.switcher.switchTo(r.session, "browser"), r.switcher.switchTo(r.session, "desktop")]);
    expect(r.log.filter((l) => l.startsWith("screen.switch"))).toEqual(["screen.switch browser", "screen.switch desktop"]);
    expect(r.switcher.active(r.session).screen).toBe("desktop");
  });
});
