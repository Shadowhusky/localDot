import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RawData, WebSocket } from "ws";
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
const OUT = fileURLToPath(new URL("./testing/out/", import.meta.url));

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

// The random token may start with "-": hashing it must treat it as data, not an openssl option.
const STREAM_PASSWORD = `-${"p".repeat(42)}`;
const STREAM_AUTH = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
const DESKTOPD_TOKEN = "d".repeat(43);
const HOME_VOLUME = "localdot-test-desktop-home";

function startDesktop(name: string, scale: 1 | 2): { port: number; desktopd: number } {
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
    "-p",
    "127.0.0.1:0:7700",
    "-v",
    `${HOME_VOLUME}:/config`,
    "-e",
    `PASSWORD=${STREAM_PASSWORD}`,
    "-e",
    `LOCALDOT_DESKTOPD_TOKEN=${DESKTOPD_TOKEN}`,
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
  return { port: publishedPort(name, "3000"), desktopd: publishedPort(name, "7700") };
}

interface DesktopdHealth {
  ok: boolean;
  scale: number;
  screen: unknown;
  hidpi: { ok: boolean };
}

async function desktopdHealth(port: number): Promise<DesktopdHealth> {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { authorization: `Bearer ${DESKTOPD_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as DesktopdHealth;
}

const xfconf = (name: string, channel: string, prop: string) =>
  outputAs(name, "abc", "xfconf-query", "-c", channel, "-p", prop).trim();

// Where the menu-bar panel or the dock sits, and the screen edge it reserves: its strut reads left,
// right, top, bottom, then each edge's start and end.
function dockWindow(name: string, classname: string) {
  const search = ["xdotool", "search", "--onlyvisible", "--classname", classname];
  waitFor(classname, () => dockerExecAs(name, "abc", ...search).status === 0, 60_000);
  const id = outputAs(name, "abc", ...search).trim();
  const geometry = outputAs(name, "abc", "xdotool", "getwindowgeometry", "--shell", id);
  const pick = (key: string) => Number(new RegExp(`^${key}=(\\d+)$`, "m").exec(geometry)?.[1]);
  const strut = outputAs(name, "abc", "xprop", "-id", id, "_NET_WM_STRUT_PARTIAL");
  return {
    x: pick("X"),
    y: pick("Y"),
    width: pick("WIDTH"),
    height: pick("HEIGHT"),
    strut: /= ([\d, ]+)$/m.exec(strut)?.[1],
  };
}

const PLANK_DOCK = "net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/";
const COMPOSITOR_RUNNING = `from Xlib import X, display
d = display.Display()
print(d.get_selection_owner(d.intern_atom("_NET_WM_CM_S0")) != X.NONE)`;
const WALLPAPER = "/usr/share/backgrounds/localdot/daylight.png";
// Colours of the wallpaper itself at fixed points, so a drawn pixel shows which image xfdesktop uses.
const SKY = { 2: "srgb(176,212,240)", 1: "srgb(177,213,241)" };
const FIELD = { 2: "srgb(198,221,234)", 1: "srgb(199,222,235)" };

const screenPixel = (name: string, x: number, y: number) =>
  outputAs(
    name,
    "abc",
    "import",
    "-window",
    "root",
    "-crop",
    `1x1+${x}+${y}`,
    "-format",
    "%[pixel:p{0,0}]",
    "info:",
  );

// xfdesktop reads the wallpaper under the X output's own name ("screen" under Xvfb).
function wallpaper(name: string): string {
  const output = /^(\S+) connected/m.exec(outputAs(name, "abc", "xrandr"))?.[1];
  const image = xfconf(
    name,
    "xfce4-desktop",
    `/backdrop/screen0/monitor${output}/workspace0/last-image`,
  );
  outputOf(name, "test", "-f", image);
  return image;
}

// One Thunar window shows the GTK theme, the icons and the window decorations together. The
// session's Thunar daemon owns that window, so it is closed with Ctrl+W rather than killed.
function saveLook(name: string, file: string, size: string): void {
  const search = ["xdotool", "search", "--onlyvisible", "--class", "Thunar"];
  outputAs(name, "abc", "sh", "-c", "thunar /config >/dev/null 2>&1 &");
  waitFor("Thunar", () => dockerExecAs(name, "abc", ...search).status === 0, 60_000);
  sleepSync(2000);
  outputAs(name, "abc", "import", "-window", "root", `/tmp/${file}`);
  expect(outputOf(name, "identify", "-format", "%wx%h", `/tmp/${file}`)).toBe(size);
  docker("cp", `${name}:/tmp/${file}`, join(OUT, file));
  const window = outputAs(name, "abc", ...search).trim();
  outputAs(name, "abc", "xdotool", "windowactivate", "--sync", window, "key", "ctrl+w");
  waitFor("Thunar to close", () => dockerExecAs(name, "abc", ...search).status === 1, 30_000);
}

interface ServerSetting {
  value: unknown;
  locked?: boolean;
  allowed?: unknown[];
  min?: number;
  max?: number;
}

interface ServerMessage {
  type?: string;
  settings?: Record<string, ServerSetting>;
}

// Selkies sends its settings, each with its lock, as soon as a stream socket opens. Its other
// text messages ("MODE websockets", "DISPLAY_CONFIG_UPDATE,…") are not JSON.
function serverSettings(ws: WebSocket): Promise<Record<string, ServerSetting>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no server_settings within 15 s")), 15_000);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: ServerMessage | null;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage | null;
      } catch {
        return;
      }
      if (msg?.type !== "server_settings" || !msg.settings) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg.settings);
    };
    ws.on("message", onMessage);
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Resolves with "open", or with the error ws raises when the upgrade is refused.
function upgradeOutcome(url: string): Promise<string> {
  const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
  return new Promise<string>((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.on("error", (error) => resolve(error.message));
  }).finally(() => ws.terminate());
}

describe.skipIf(!DOCKER_TESTS)("desktop image: session bus, HiDPI and Selkies", () => {
  const C2 = "localdot-test-desktop-2x";
  const C1 = "localdot-test-desktop-1x";
  const HOME_EDIT = "localdot-test-desktop-home-edit";
  let port2 = 0;
  let desktopd2 = 0;

  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    removeAll({ containers: [C2, C1, HOME_EDIT], volumes: [HOME_VOLUME] });
    const started = startDesktop(C2, 2);
    port2 = started.port;
    desktopd2 = started.desktopd;
  });
  afterAll(() => removeAll({ containers: [C2, C1, HOME_EDIT], volumes: [HOME_VOLUME] }));

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

  it("renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled menu bar", () => {
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C2, "xfwm4", "/general/theme")).toBe("WhiteSur-Light-xhdpi");
    expect(outputAs(C2, "abc", "xdpyinfo")).toMatch(/dimensions:\s+2560x1600/);
    // The menu bar is 24 pt: 24 px at 1x, 48 at 2x. It is the only edge a maximized window gives up.
    expect(dockWindow(C2, "xfce4-panel")).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 48,
      strut: "0, 0, 48, 0, 0, 0, 0, 0, 0, 2558, 0, 0",
    });
    expect(outputAs(C2, "abc", "xprop", "-root", "_NET_WORKAREA")).toContain("= 0, 48, 2560, 1552");
  });

  // xfwm4's default vblank mode syncs through XPresent, which doubled input-to-frame latency in S8.
  // xfwm4 reads the mode only as it starts, after startwm.sh has written the template.
  it("composites without vsync", () => {
    expect(xfconf(C2, "xfwm4", "/general/vblank_mode")).toBe("off");
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
    const html = await page.text();
    const entry = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(html)?.[1];
    expect(entry, html).toBeDefined();
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
    expect(await upgradeOutcome(`ws://127.0.0.1:${port2}/api/websockets`)).toBe(
      "Unexpected server response: 401",
    );
  });

  it("locks every Selkies switch and keeps the HiDPI settings while a stream socket is open", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/api/websockets`, {
      headers: { authorization: STREAM_AUTH },
    });
    const settings = await serverSettings(ws);
    await sleep(3000);
    ws.close();
    const lockedOff = [
      "enable_binary_clipboard",
      "enable_resize",
      "use_css_scaling",
      "enable_cursors",
      "audio_enabled",
      "microphone_enabled",
      "webcam_enabled",
      "gamepad_enabled",
      "printing_enabled",
      "command_enabled",
      "ui_show_sidebar",
      "ui_show_core_buttons",
      "ui_show_logo",
    ];
    for (const name of lockedOff) {
      expect(settings[name], name).toMatchObject({ value: false, locked: true });
    }
    expect(settings.video_fullcolor).toMatchObject({ value: false, locked: true });
    expect(settings.manual_resolution).toMatchObject({ value: true, locked: true });
    expect(settings.scaling_dpi).toMatchObject({ value: "96", locked: true });
    // A range is locked when its span is one value, an enum when it allows one item.
    expect(settings.framerate).toMatchObject({ value: [60, 60], min: 60, max: 60 });
    expect(settings.encoder).toMatchObject({ value: "h264enc", allowed: ["h264enc"] });
    // No client message sets the clipboard or file-transfer policy, so Selkies gives them no lock.
    expect(settings.enable_clipboard?.value).toBe("false");
    for (const name of ["clipboard_enabled", "clipboard_in_enabled", "clipboard_out_enabled"]) {
      expect(settings[name]?.value, name).toBe(false);
    }
    expect(settings.file_transfers).toMatchObject({ value: [], allowed: [] });
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

  it("wears the light look with a floating dock and a glass menu bar", () => {
    expect(xfconf(C2, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    const icons = xfconf(C2, "xsettings", "/Net/IconThemeName");
    expect(icons).toBe("WhiteSur-light");
    // WhiteSur draws its panel-size status icons white for a dark bar; its -light variant
    // recolours them dark, which the light bar needs for any non-symbolic tray icon.
    const statusIcon = outputOf(
      C2,
      "cat",
      `/usr/share/icons/${icons}/status/16/audio-volume-high.svg`,
    );
    expect(statusIcon).toContain("color:#363636");
    expect(statusIcon).not.toContain("#f2f2f2");
    expect(xfconf(C2, "xfwm4", "/general/button_layout")).toBe("CHM|");
    // xfconf only echoes the templates, and xfwm4 falls back to Default for a missing theme.
    outputOf(
      C2,
      "ls",
      "/usr/share/themes/WhiteSur-Light/gtk-3.0/gtk.css",
      "/usr/share/themes/WhiteSur-Light/gtk-4.0/gtk.css",
      "/usr/share/themes/WhiteSur-Light/xfwm4/themerc",
      "/usr/share/themes/WhiteSur-Light-hdpi/xfwm4/themerc",
      "/usr/share/themes/WhiteSur-Light-xhdpi/xfwm4/themerc",
      "/usr/share/icons/WhiteSur/index.theme",
      "/usr/share/icons/WhiteSur-light/index.theme",
      "/usr/share/plank/themes/localdot-glass/dock.theme",
      "/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING",
      "/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING",
      "/usr/share/doc/localdot-themes/THIRD-PARTY.md",
      "/usr/share/doc/plank/copyright",
      "/usr/share/doc/xfce4-appmenu-plugin/copyright",
      "/usr/share/doc/rofi/copyright",
    );
    const closeButton = (theme: string) =>
      outputOf(
        C2,
        "identify",
        "-format",
        "%wx%h",
        `/usr/share/themes/${theme}/xfwm4/close-active.png`,
      );
    expect(closeButton("WhiteSur-Light")).toBe("24x28");
    expect(closeButton("WhiteSur-Light-xhdpi")).toBe("48x56");
    const plugins = outputAs(C2, "abc", "xfconf-query", "-c", "xfce4-panel", "-l", "-v");
    for (const plugin of ["applicationsmenu", "appmenu", "launcher", "clock"]) {
      expect(plugins).toContain(plugin);
    }
    expect(plugins).not.toContain("tasklist");
    expect(plugins).not.toContain("systray");
    // No session menu: the cell has no logind, and a log-out would end the agent's session.
    expect(plugins).not.toContain("actions");
    // A name no icon theme has draws GTK's red "missing image" sign on the menu button.
    const menuIcon = /button-icon\s+(\S+)/.exec(plugins)?.[1];
    outputOf(C2, "test", "-f", `/usr/share/icons/hicolor/scalable/apps/${menuIcon}.svg`);
    // The menu bar is translucent over the wallpaper, and Plank's translucent dock needs the
    // compositor (without one it draws an opaque grey block).
    expect(screenPixel(C2, 1280, 10)).toBe("srgb(238,240,246)");
    expect(outputAs(C2, "abc", "python3", "-c", COMPOSITOR_RUNNING).trim()).toBe("True");
    expect(dockerExecAs(C2, "abc", "pgrep", "-x", "plank").status).toBe(0);
    expect(outputAs(C2, "abc", "gsettings", "get", PLANK_DOCK, "theme").trim()).toBe(
      "'localdot-glass'",
    );
    expect(outputAs(C2, "abc", "gsettings", "get", PLANK_DOCK, "hide-mode").trim()).toBe(
      "'window-dodge'",
    );
    // The dock floats: it reserves no screen edge, so a maximized window reaches the bottom.
    const dock = dockWindow(C2, "plank");
    expect(dock.y + dock.height).toBe(1600);
    expect(dock.strut).toBe("0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0");
    const launchers = outputAs(
      C2,
      "abc",
      "sh",
      "-c",
      "sed -n 's,^Launcher=file://,,p' /config/.config/plank/dock1/launchers/*.dockitem | xargs ls",
    );
    expect(launchers.trim().split("\n")).toEqual([
      "/usr/local/share/applications/chromium.desktop",
      ...[
        "codium",
        "gimp",
        "libreoffice-calc",
        "libreoffice-impress",
        "libreoffice-writer",
        "org.xfce.mousepad",
        "thunar",
        "xfce4-terminal",
      ].map((app) => `/usr/share/applications/${app}.desktop`),
    ]);
  });

  // WhiteSur draws the Apple logo for its start-here icons and its GNOME Shell activities button.
  it("ships WhiteSur without its Apple logos", () => {
    const appleLogos = outputOf(
      C2,
      "find",
      "/usr/share/themes/WhiteSur-Light",
      "/usr/share/icons/WhiteSur",
      "/usr/share/icons/WhiteSur-light",
      "/usr/share/icons/WhiteSur-dark",
      "(",
      "-path",
      "*/gnome-shell",
      "-o",
      "-name",
      "start-here.svg",
      "-o",
      "-name",
      "start-here-symbolic.svg",
      "-o",
      "-name",
      "folder-apple*",
      "-o",
      "-lname",
      "start-here*",
      ")",
      "-print",
    );
    expect(appleLogos).toBe("");
  });

  it("draws the Daylight wallpaper from a new home's xfdesktop settings", () => {
    expect(wallpaper(C2)).toBe(WALLPAPER);
    expect(screenPixel(C2, 2400, 200)).toBe(SKY[2]);
    expect(screenPixel(C2, 2000, 1200)).toBe(FIELD[2]);
    // A dock shadow would draw a band across the screen above Plank's tall, transparent window.
    expect(screenPixel(C2, 2000, dockWindow(C2, "plank").y - 6)).toBe("srgb(185,216,231)");
  });

  it("saves a 2x screenshot of the themed desktop for the executor to look at", () => {
    saveLook(C2, "look-2x.png", "2560x1600");
  });

  it("runs desktopd as the desktop user behind the cell token", async () => {
    const desktopd = outputOf(C2, "ps", "-eo", "user=,args=")
      .split("\n")
      .filter((line) => line.includes("desktopd.mjs"));
    expect(desktopd).toEqual([
      expect.stringMatching(/^abc\s+\/opt\/node\/bin\/node \/opt\/localdot\/desktopd\.mjs$/),
    ]);
    // The expanded bundle retains Hono, its server, the MCP SDK and their dependencies' notices.
    expect(
      outputOf(C2, "grep", "-c", "^Permission is hereby granted", "/opt/localdot/desktopd.mjs"),
    ).toBe("13\n");
    expect((await fetch(`http://127.0.0.1:${desktopd2}/healthz`)).status).toBe(401);
    const health = await desktopdHealth(desktopd2);
    expect(health.ok).toBe(true);
    expect(health.scale).toBe(2);
    expect(health.screen).toEqual({ w: 2560, h: 1600 });
    expect(health.hidpi.ok).toBe(true);
  });

  // C1 starts on C2's home, so the 2x settings already in it must give way to the 1x ones, and a
  // channel missing from it (as when xfconfd made the folder first) is filled from the defaults.
  it("switches to 1x with LOCALDOT_SCALE=1", async () => {
    removeAll({ containers: [C2] });
    docker(
      "run",
      "--rm",
      "--name",
      HOME_EDIT,
      "-v",
      `${HOME_VOLUME}:/config`,
      "--entrypoint",
      "rm",
      DESKTOP_IMAGE,
      "/config/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml",
    );
    const { desktopd } = startDesktop(C1, 1);
    expect(xfconf(C1, "xsettings", "/Gdk/WindowScalingFactor")).toBe("1");
    expect(xfconf(C1, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C1, "xfwm4", "/general/theme")).toBe("WhiteSur-Light");
    expect(xfconf(C1, "xfwm4", "/general/vblank_mode")).toBe("off");
    expect(outputAs(C1, "abc", "xdpyinfo")).toMatch(/dimensions:\s+1280x800/);
    expect(await desktopdHealth(desktopd)).toMatchObject({
      ok: true,
      scale: 1,
      screen: { w: 1280, h: 800 },
      hidpi: { ok: true },
    });
    expect(dockWindow(C1, "xfce4-panel")).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 24,
      strut: "0, 0, 24, 0, 0, 0, 0, 0, 0, 1279, 0, 0",
    });
    const dock = dockWindow(C1, "plank");
    expect(dock.y + dock.height).toBe(800);
    expect(dock.strut).toBe("0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0");
    expect(xfconf(C1, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    expect(wallpaper(C1)).toBe(WALLPAPER);
    expect(screenPixel(C1, 1200, 100)).toBe(SKY[1]);
    expect(screenPixel(C1, 1000, 600)).toBe(FIELD[1]);
    saveLook(C1, "look-1x.png", "1280x800");
  });
});
