import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Test-only cross-package import: the helper's TypeScript client lives with desktopd.
import {
  startXHelper,
  type XEvent,
  type XHelper,
} from "../../../../cells/desktop/desktopd/src/x/helper.ts";
import {
  type DesktopContainer,
  execAsDesktopUser,
  launchInDesktop,
  startDesktopContainer,
  windowGeometry,
} from "./testing/desktop-container.ts";
import {
  DOCKER_TESTS,
  dockerExec,
  dockerExecAs,
  removeAll,
  sleepSync,
  waitFor,
} from "./testing/docker-cli.ts";

const C = "localdot-test-desktopd";
let x: XHelper;
const events: XEvent[] = [];

const waitEvent = async (pred: (e: XEvent) => boolean, ms: number): Promise<XEvent | undefined> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
};

describe.skipIf(!DOCKER_TESTS)("desktopd: the X helper inside the image", () => {
  beforeAll(async () => {
    startDesktopContainer(C, 2);
    x = await startXHelper({
      command: "docker",
      // /usr/bin/python3, not the venv the base image puts first on PATH (/lsiopy), which has no python-xlib.
      args: [
        "exec",
        "-i",
        "-u",
        "abc",
        "-e",
        "DISPLAY=:1",
        "-e",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
        C,
        "/usr/bin/python3",
        "-u",
        "/opt/localdot/xhelper.py",
      ],
    });
    x.onEvent((e) => events.push(e));
  });
  afterAll(async () => {
    await x?.close();
    removeAll({ containers: [C] });
  });

  it("keeps the virtual display awake without synthetic input or keepalive polling", () => {
    const probe = dockerExecAs(
      C,
      "abc",
      "/usr/bin/python3",
      "-c",
      "from Xlib import display; d=display.Display(); s=d.get_screen_saver(); print(s.timeout, s.interval)",
    );
    expect(probe.status, probe.out).toBe(0);
    expect(probe.out.trim()).toBe("0 0");
  });

  it("shares CLOCK_MONOTONIC with Node in the cell", async () => {
    const pong = await x.call<{ mono: number }>("ping");
    const probe = dockerExec(C, "node", "-e", "console.log(Number(process.hrtime.bigint()) / 1e6)");
    expect(probe.status, probe.out).toBe(0);
    const node = Number(probe.out.trim());
    expect(Math.abs(node - pong.mono)).toBeLessThan(2000);
    expect(pong.mono).toBeGreaterThan(1000);
  });

  it("lists windows top-most first with device-pixel geometry and activates one as an event", async () => {
    launchInDesktop(C, "xfce4-terminal");
    waitFor("terminal window", () => windowGeometry(C, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(1500);
    const { windows } = await x.call<{
      windows: {
        id: number;
        cls: string;
        x: number;
        y: number;
        w: number;
        h: number;
        active: boolean;
      }[];
    }>("windows");
    // The panel, the dock and the desktop are windows too and may sit above clients in the
    // stacking order; the comparison is about the top-most client window.
    const DECOR = new Set(["Xfce4-panel", "Plank", "Xfdesktop"]);
    const clients = windows.filter((w) => !DECOR.has(w.cls));
    const terminal = clients.find((w) => w.cls === "Xfce4-terminal");
    expect(terminal).toBeDefined();
    expect(terminal?.w).toBeGreaterThan(100);
    expect(clients[0]?.id).toBe(terminal?.id);
    launchInDesktop(C, "thunar");
    waitFor("thunar window", () => windowGeometry(C, "thunar") !== undefined, 30_000);
    sleepSync(1500);
    const again = await x.call<{ windows: { id: number; cls: string; active: boolean }[] }>(
      "windows",
    );
    expect(again.windows.filter((w) => !DECOR.has(w.cls))[0]?.cls).toMatch(/^Thunar(?:-real)?$/);
    const back = await x.call<{ active: number; changed: boolean; waitedMs: number }>("activate", {
      window: terminal?.id,
    });
    expect(back.active).toBe(terminal?.id);
    expect(back.changed).toBe(true);
    expect(back.waitedMs).toBeLessThan(300);
    expect(
      (await x.call<{ active: number; changed: boolean }>("activate", { window: terminal?.id }))
        .changed,
    ).toBe(false);
  });

  it("clicks with XTest and stamps the raw press within 100 ms of the command", async () => {
    const g = windowGeometry(C, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    events.length = 0;
    const before = (await x.call<{ mono: number }>("ping")).mono;
    const reply = await x.call<{ presses: number }>("click", {
      x: g.x + g.w / 2,
      y: g.y + g.h / 2,
      button: 1,
      count: 1,
    });
    expect(reply.presses).toBe(1);
    const press = await waitEvent(
      (e) => e.ev === "press" && e.kind === "button" && e.detail === 1,
      500,
    );
    const release = await waitEvent(
      (e) => e.ev === "release" && e.kind === "button" && e.detail === 1,
      500,
    );
    expect(press).toBeDefined();
    expect(release).toBeDefined();
    expect((press?.mono ?? 0) - before).toBeGreaterThanOrEqual(0);
    expect((press?.mono ?? 0) - before).toBeLessThan(100);
    expect((release?.mono ?? 0) - (press?.mono ?? 0)).toBeLessThan(10);
  });

  it("types characters, shifted and remapped ones included, and sees the key presses", async () => {
    events.length = 0;
    for (const ch of "echo H_i é€ > /tmp/typed.txt") await x.call("char", { ch });
    const keys = await x.call<{ keycodes: number[] }>("keys", { combo: ["Return"] });
    expect(keys.keycodes).toHaveLength(1);
    const presses = events.filter((e) => e.ev === "press" && e.kind === "key");
    expect(presses.length).toBeGreaterThanOrEqual("echo H_i é€ > /tmp/typed.txt".length + 1);
    waitFor("typed file", () => dockerExec(C, "cat", "/tmp/typed.txt").status === 0, 5000);
    const typed = dockerExec(C, "cat", "/tmp/typed.txt");
    expect(typed.status, typed.out).toBe(0);
    expect(typed.out.trim()).toBe("H_i é€");
  });

  it("reports damage after a change and no visible change on a still screen", async () => {
    await x.call("arm");
    await x.call("char", { ch: "x" });
    const changed = await x.call<{
      changed: number[][];
      quiet: boolean;
      noVisibleChange: boolean;
      lastChange: number | null;
    }>("settle", { quietMs: 250, timeoutMs: 3000 });
    expect(changed.noVisibleChange).toBe(false);
    expect(changed.changed.length).toBeGreaterThan(0);
    expect(changed.lastChange).toBeGreaterThan(0);
    await x.call("keys", { combo: ["BackSpace"] });
    sleepSync(500);
    await x.call("arm");
    const still = await x.call<{ noVisibleChange: boolean; quiet: boolean }>("settle", {
      quietMs: 250,
      firstMs: 800,
      timeoutMs: 3000,
    });
    expect(still.noVisibleChange).toBe(true);
    expect(still.quiet).toBe(true);
    // The session's own xfconfd, through its bus: a probe as root would start a bus of its own.
    const blink = execAsDesktopUser(C, "xfconf-query", "-c", "xsettings", "-p", "/Net/CursorBlink");
    expect(blink.status, blink.out).toBe(0);
    expect(blink.out.trim()).toBe("false");
  });

  it("launches Chromium maximized with the DevTools port on loopback", async () => {
    launchInDesktop(C, "/usr/local/bin/localdot-chromium", "about:blank");
    waitFor("chromium window", () => windowGeometry(C, "chromium") !== undefined, 60_000);
    sleepSync(3000);
    const g = windowGeometry(C, "chromium");
    expect(g?.w).toBe(2560);
    expect(g?.y).toBe(54);
    const devtools = dockerExecAs(C, "abc", "curl", "-sf", "http://127.0.0.1:9222/json/version");
    expect(devtools.status, devtools.out).toBe(0);
    expect(devtools.out).toContain("Chrome");
    expect(
      dockerExec(
        C,
        "sh",
        "-c",
        "grep -l localdot-chromium /usr/local/share/applications/chromium.desktop",
      ).status,
    ).toBe(0);
  });
});

describe.skipIf(!DOCKER_TESTS)("desktopd: input, type, settle, launch over HTTP", () => {
  const C2 = "localdot-test-desktopd-http";
  let cell: DesktopContainer;
  const post = async (path: string, body: unknown) =>
    fetch(`${cell.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cell.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(() => {
    cell = startDesktopContainer(C2, 2);
  });
  afterAll(() => removeAll({ containers: [C2] }));

  it("launches the terminal, clicks it, types a command and settles", async () => {
    const launched = await post("/launch", { app: "terminal" });
    expect(launched.status).toBe(200);
    waitFor("terminal", () => windowGeometry(C2, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(1500);
    const g = windowGeometry(C2, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    const clock = (await (
      await fetch(`${cell.baseUrl}/clock`, { headers: { authorization: `Bearer ${cell.token}` } })
    ).json()) as { mono: number };
    const click = await post("/input", {
      input: {
        kind: "click",
        button: "left",
        count: 1,
        at: { x: g.x + g.w / 2, y: g.y + g.h / 2 },
      },
      window: g.id,
    });
    expect(click.status).toBe(200);
    const result = (await click.json()) as {
      pressMono: number;
      presses: number[];
      armedMono: number;
    };
    expect(result.pressMono).toBeGreaterThan(clock.mono);
    expect(result.pressMono - clock.mono).toBeLessThan(500);
    expect(result.presses).toHaveLength(1);

    const typed = await post("/type", {
      text: "echo typed-ok > /tmp/http.txt",
      masked: false,
      pace: { firstMs: 10, firstCount: 60, restMs: 6 },
    });
    expect(typed.status).toBe(200);
    const lines = (await typed.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { count?: number; done?: boolean; firstPressMono?: number });
    expect(lines.at(-1)).toMatchObject({
      done: true,
      count: "echo typed-ok > /tmp/http.txt".length,
    });
    expect((lines.at(-1)?.firstPressMono ?? 0) > result.pressMono).toBe(true);
    const enter = await post("/input", { input: { kind: "key", combo: ["Return"] } });
    expect(enter.status).toBe(200);
    const settled = (await (await post("/settle", {})).json()) as {
      changed: unknown[];
      quiet: boolean;
      noVisibleChange: boolean;
    };
    expect(settled.noVisibleChange).toBe(false);
    expect(settled.changed.length).toBeGreaterThan(0);
    waitFor("typed file", () => dockerExec(C2, "cat", "/tmp/http.txt").status === 0, 5000);
    const file = dockerExec(C2, "cat", "/tmp/http.txt");
    expect(file.status, file.out).toBe(0);
    expect(file.out.trim()).toBe("typed-ok");
  });

  it("refuses unknown apps, dangerous arguments and a window that cannot be activated", async () => {
    expect((await post("/launch", { app: "bash" })).status).toBe(400);
    expect((await post("/launch", { app: "terminal", args: ["-e", "rm -rf /"] })).status).toBe(400);
    // A missing target window must never send input into whichever window is currently active.
    const odd = await post("/input", {
      input: { kind: "click", button: "middle", count: 1, at: { x: 5, y: 1590 } },
      window: 1,
    });
    expect(odd.status).toBe(409);
  });
});
