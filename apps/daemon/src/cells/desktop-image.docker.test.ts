import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  dockerLogs,
  dockerOk,
  publishedPort,
  removeAll,
  sleepSync,
  waitFor,
} from "./testing/docker-cli.ts";

export const DESKTOP_IMAGE = "localdot/desktop:dev";
const C = "localdot-test-desktop-tools";

// A probe's output counts only if it exited 0: `out` joins stderr, and Docker's "executable file
// not found" error names the missing binary.
function outputOf(container: string, ...cmd: string[]): string {
  const r = dockerExec(container, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(0);
  return r.out;
}

function outputAs(container: string, user: string, ...cmd: string[]): string {
  const r = dockerExecAs(container, user, ...cmd);
  expect(r.status, `${cmd.join(" ")} as ${user}: ${r.out}`).toBe(0);
  return r.out;
}

describe.skipIf(!DOCKER_TESTS)("desktop image: pinned tools", () => {
  beforeAll(() => {
    if (!dockerOk("image", "inspect", DESKTOP_IMAGE)) {
      throw new Error(`${DESKTOP_IMAGE} is missing: run cells/desktop/build.sh first`);
    }
    removeAll({ containers: [C] });
    docker("run", "-d", "--name", C, "--network", "none", "--shm-size=1g", DESKTOP_IMAGE);
  });

  afterAll(() => removeAll({ containers: [C] }));

  it("ships the app set", () => {
    expect(outputOf(C, "libreoffice", "--version")).toContain("LibreOffice");
    expect(outputAs(C, "abc", "codium", "--version").split("\n")[0]).toBe("1.135.06055");
    expect(outputOf(C, "gimp", "--version")).toMatch(/Image Manipulation Program/);
    expect(outputOf(C, "ffmpeg", "-version")).toContain("ffmpeg version");
    expect(outputOf(C, "convert", "-version")).toContain("ImageMagick");
    expect(outputOf(C, "pandoc", "--version")).toMatch(/^pandoc \d/m);
    expect(outputOf(C, "chromium-browser", "--version")).toContain("Chromium");
    for (const tool of ["thunar", "xfce4-terminal", "mousepad", "git", "curl", "jq", "python3"]) {
      expect(dockerExec(C, "sh", "-c", `command -v ${tool}`).status, tool).toBe(0);
    }
  });

  it("ships Node 24.21.0", () => {
    expect(outputOf(C, "node", "--version").trim()).toBe("v24.21.0");
    expect(outputOf(C, "readlink", "-f", "/usr/local/bin/node").trim()).toBe("/opt/node/bin/node");
  });

  it("runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off", () => {
    expect(outputAs(C, "abc", "cua-driver", "--version")).toContain("0.30.4");
    const env = docker("image", "inspect", "--format", "{{json .Config.Env}}", DESKTOP_IMAGE);
    expect(env).toContain('"CUA_DRIVER_RS_TELEMETRY_ENABLED=0"');
    expect(env).toContain('"CUA_DRIVER_RS_UPDATE_CHECK=0"');
    expect(env).toContain('"CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0"');
    expect(env).toContain('"START_DOCKER=false"');
  });

  it("has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji", () => {
    const families = outputOf(C, "fc-list", ":", "family");
    expect(families).toMatch(/\bInter\b/);
    expect(families).toContain("JetBrains Mono");
    expect(families).toContain("Noto Sans CJK");
    expect(families).toContain("Noto Color Emoji");
  });

  it("has the X, accessibility and certificate tools", () => {
    expect(dockerExec(C, "xinput", "--version").status).toBe(0);
    expect(dockerExec(C, "python3", "-c", "import Xlib").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "command -v xprop && command -v certutil").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "ls /usr/libexec/at-spi-bus-launcher").status).toBe(0);
  });
});

const STREAM_PASSWORD = "p".repeat(43);
const STREAM_AUTH = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
const HOME_VOLUME = "localdot-test-desktop-home";

function startDesktop(name: string, scale: 1 | 2): { port: number } {
  removeAll({ containers: [name] });
  const [w, h] = scale === 2 ? ["2560", "1600"] : ["1280", "800"];
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--shm-size=1g",
    "--cap-drop",
    "NET_RAW",
    "-p",
    "127.0.0.1:0:3000",
    "-v",
    `${HOME_VOLUME}:/config`,
    "-e",
    `PASSWORD=${STREAM_PASSWORD}`,
    "-e",
    `LOCALDOT_SCALE=${scale}`,
    "-e",
    `SELKIES_MANUAL_WIDTH=${w}`,
    "-e",
    `SELKIES_MANUAL_HEIGHT=${h}`,
    DESKTOP_IMAGE,
  );
  waitFor(
    "xfce4-panel",
    () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0,
    180_000,
  );
  sleepSync(5000);
  return { port: publishedPort(name, "3000") };
}

const xfconf = (name: string, channel: string, prop: string) =>
  outputAs(name, "abc", "xfconf-query", "-c", channel, "-p", prop).trim();

function panelGeometry(name: string): { WIDTH: number; HEIGHT: number }[] {
  const ids = outputAs(name, "abc", "xdotool", "search", "--classname", "xfce4-panel").trim();
  return ids
    .split("\n")
    .filter(Boolean)
    .map((id) => {
      const out = outputAs(name, "abc", "xdotool", "getwindowgeometry", "--shell", id);
      const pick = (key: string) => Number(new RegExp(`^${key}=(\\d+)$`, "m").exec(out)?.[1]);
      return { WIDTH: pick("WIDTH"), HEIGHT: pick("HEIGHT") };
    });
}

interface ServerSetting {
  value: unknown;
  locked?: boolean;
  allowed?: unknown[];
}

// Selkies sends its settings, each with its lock, as soon as a stream socket opens.
function serverSettings(ws: WebSocket): Promise<Record<string, ServerSetting>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no server_settings within 15 s")), 15_000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (!text.startsWith("{")) return;
      const msg = JSON.parse(text) as { type?: string; settings?: Record<string, ServerSetting> };
      if (msg.type !== "server_settings" || !msg.settings) return;
      clearTimeout(timer);
      resolve(msg.settings);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe.skipIf(!DOCKER_TESTS)("desktop image: session bus, HiDPI and Selkies", () => {
  const C2 = "localdot-test-desktop-2x";
  const C1 = "localdot-test-desktop-1x";
  let port2 = 0;

  beforeAll(() => {
    removeAll({ containers: [C2, C1], volumes: [HOME_VOLUME] });
    port2 = startDesktop(C2, 2).port;
  });
  afterAll(() => removeAll({ containers: [C2, C1], volumes: [HOME_VOLUME] }));

  it("runs exactly one session bus at the fixed address and no dbus-launch", () => {
    // dbus-launch puts --session after its own flags, so this counts its buses too.
    expect(outputOf(C2, "pgrep", "-c", "-f", "dbus-daemon.*--session").trim()).toBe("1");
    expect(dockerExec(C2, "pgrep", "-c", "-x", "dbus-launch")).toEqual({ status: 1, out: "0\n" });
    expect(dockerExecAs(C2, "abc", "sh", "-c", "test -S /tmp/localdot-session-bus").status).toBe(0);
    expect(outputAs(C2, "abc", "printenv", "DBUS_SESSION_BUS_ADDRESS").trim()).toBe(
      "unix:path=/tmp/localdot-session-bus",
    );
  });

  it("has AT-SPI on that bus", () => {
    const root = outputAs(C2, "abc", "xprop", "-root", "AT_SPI_BUS");
    const address = /"(unix:[^"]+)"/.exec(root)?.[1];
    expect(address, root).toMatch(/^unix:/);
    expect(outputOf(C2, "pgrep", "-c", "-f", "at-spi-bus-launcher").trim()).toBe("1");
    const reply = outputAs(
      C2,
      "abc",
      "dbus-send",
      "--session",
      "--print-reply",
      "--dest=org.a11y.Bus",
      "/org/a11y/bus",
      "org.a11y.Bus.GetAddress",
    );
    expect(reply).toContain(`string "${address}"`);
  });

  it("renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled panel", () => {
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C2, "xfwm4", "/general/theme")).toBe("Default-xhdpi");
    expect(outputAs(C2, "abc", "xdpyinfo")).toMatch(/dimensions:\s+2560x1600/);
    // The panel's window is one pixel taller than its xfconf size of 26: 27 at 1x, 54 at 2x.
    expect(panelGeometry(C2)).toContainEqual({ WIDTH: 2560, HEIGHT: 54 });
  });

  it("starts Selkies fixed at 2560x1600 with audio off and the stream behind basic auth", async () => {
    const log = dockerLogs(C2);
    expect(log).toContain("fixed 2560x1600");
    expect(log).toContain("audio off");
    expect((await fetch(`http://127.0.0.1:${port2}/`)).status).toBe(401);
    const page = await fetch(`http://127.0.0.1:${port2}/`, {
      headers: { authorization: STREAM_AUTH },
    });
    expect(page.status).toBe(200);
    // The page's entry module imports the client core (assets/selkies-core-*.js).
    const entry = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(await page.text())?.[1];
    const script = await fetch(`http://127.0.0.1:${port2}/${entry}`, {
      headers: { authorization: STREAM_AUTH },
    });
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("selkies-core");
    const health = await fetch(`http://127.0.0.1:${port2}/api/health`, {
      headers: { authorization: STREAM_AUTH },
    });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port2}/api/health`)).status).toBe(401);
  });

  it("locks the scaling settings and keeps the HiDPI settings while a stream socket is open", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/api/websockets`, {
      headers: { authorization: STREAM_AUTH },
    });
    const settings = await serverSettings(ws);
    sleepSync(3000);
    ws.close();
    expect(settings.scaling_dpi).toMatchObject({ value: "96", locked: true });
    expect(settings.enable_resize).toMatchObject({ value: false, locked: true });
    expect(settings.use_css_scaling).toMatchObject({ value: false, locked: true });
    expect(settings.enable_cursors).toMatchObject({ value: false, locked: true });
    expect(settings.encoder?.allowed).toEqual(["h264enc"]);
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
  });

  it("opens Thunar in list view", () => {
    expect(xfconf(C2, "thunar", "/default-view")).toBe("ThunarDetailsView");
    expect(xfconf(C2, "thunar", "/last-view")).toBe("ThunarDetailsView");
  });

  it("seeds the LibreOffice profile so no first-run dialog appears", () => {
    const xcu = outputAs(
      C2,
      "abc",
      "cat",
      "/config/.config/libreoffice/4/user/registrymodifications.xcu",
    );
    expect(xcu).toContain('<prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop>');
    expect(xcu).toContain(
      '<prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop>',
    );
    expect(xcu).toContain('<prop oor:name="WhatsNew" oor:op="fuse"><value>false</value></prop>');
    const launch = dockerExecAs(C2, "abc", "sh", "-c", "libreoffice --calc >/dev/null 2>&1 &");
    expect(launch.status).toBe(0);
    const visible = (name: string) =>
      dockerExecAs(C2, "abc", "xdotool", "search", "--onlyvisible", "--name", name);
    waitFor("LibreOffice Calc", () => visible("LibreOffice Calc").status === 0, 60_000);
    // Unless WhatsNew is off, "Welcome to LibreOffice!" follows the Calc window within a second.
    sleepSync(5000);
    const dialogs = visible("Welcome to LibreOffice|Tip of the Day");
    expect(dockerExecAs(C2, "abc", "pkill", "-f", "soffice").status).toBe(0);
    waitFor(
      "LibreOffice to exit",
      () => dockerExec(C2, "pgrep", "-f", "soffice").status === 1,
      30_000,
    );
    expect(dialogs, "xdotool search exits 1 when no window matches").toEqual({
      status: 1,
      out: "",
    });
  });

  // C1 starts on C2's home, so the 2x settings already in it must give way to the 1x ones.
  it("switches to 1x with LOCALDOT_SCALE=1", () => {
    removeAll({ containers: [C2] });
    startDesktop(C1, 1);
    expect(xfconf(C1, "xsettings", "/Gdk/WindowScalingFactor")).toBe("1");
    expect(xfconf(C1, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C1, "xfwm4", "/general/theme")).toBe("Default");
    expect(outputAs(C1, "abc", "xdpyinfo")).toMatch(/dimensions:\s+1280x800/);
    expect(panelGeometry(C1)).toContainEqual({ WIDTH: 1280, HEIGHT: 27 });
  });
});
