import { isIP } from "node:net";
import { ULID_PATTERN } from "@localdot/protocol";
import { z as schema } from "zod";

export const BROWSER_RUNTIME_DIR = "/tmp/browser-runtime";
export const BROWSER_PROFILE_DIR = "/profile/chromium";
export const BROWSER_UPLOAD_DIR = "/tmp/browser-runtime/uploads";
export const BROWSER_DOWNLOAD_DIR = "/downloads";
export const BROWSER_DISPLAY = ":1";

const token = schema.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const privateAddress = schema.string().refine((value) => {
  if (isIP(value) !== 4) return false;
  const parts = value.split(".").map(Number);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
});
const configSchema = schema
  .strictObject({
    browserCellId: schema.string().regex(ULID_PATTERN),
    parentCellId: schema.string().regex(ULID_PATTERN),
    serviceToken: token,
    streamToken: token,
    gateAddress: privateAddress,
    scale: schema.union([schema.literal(1), schema.literal(2)]),
    fullcolor: schema.boolean(),
  })
  .refine((value) => value.browserCellId !== value.parentCellId)
  .refine((value) => value.serviceToken !== value.streamToken);

export type BrowserRuntimeConfig = Readonly<schema.infer<typeof configSchema>>;

export class BrowserConfigurationError extends Error {
  constructor() {
    super("Browser configuration is invalid");
  }
}

// iPhones and iPads cannot decode H.264 4:4:4, so the stream is 4:2:0 unless the daemon opts in.
function streamFullcolor(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "0") return false;
  return value === "1" ? true : undefined;
}

export function browserRuntimeConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): BrowserRuntimeConfig {
  const parsed = configSchema.safeParse({
    browserCellId: environment.LOCALDOT_BROWSER_CELL_ID,
    parentCellId: environment.LOCALDOT_PARENT_CELL_ID,
    serviceToken: environment.LOCALDOT_BROWSERD_TOKEN,
    streamToken: environment.LOCALDOT_STREAM_TOKEN,
    gateAddress: environment.LOCALDOT_GATE_ADDR,
    scale:
      environment.LOCALDOT_SCALE === "1" ? 1 : environment.LOCALDOT_SCALE === "2" ? 2 : undefined,
    fullcolor: streamFullcolor(environment.LOCALDOT_STREAM_FULLCOLOR),
  });
  if (!parsed.success) throw new BrowserConfigurationError();
  return Object.freeze(parsed.data);
}

export interface BrowserProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly channel: "none" | "stdio" | "cdp";
}

export type BrowserProcessName =
  | "display"
  | "dbus"
  | "windowManager"
  | "stream"
  | "streamProxy"
  | "forwarder"
  | "xhelper"
  | "capture"
  | "chromium";

function spec(
  executable: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  channel: BrowserProcessSpec["channel"] = "none",
): BrowserProcessSpec {
  return Object.freeze({
    executable,
    args: Object.freeze([...args]),
    env: Object.freeze({ ...env }),
    channel,
  });
}

export function browserProcessSpecs(
  config: BrowserRuntimeConfig,
): Readonly<Record<BrowserProcessName, BrowserProcessSpec>> {
  const checked = configSchema.safeParse(config);
  if (!checked.success) throw new BrowserConfigurationError();
  const scale = checked.data.scale;
  const width = 1280 * scale;
  const height = 800 * scale;
  const common = {
    PATH: "/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/browser",
    USER: "abc",
    LANG: "C.UTF-8",
    DISPLAY: BROWSER_DISPLAY,
    XDG_RUNTIME_DIR: BROWSER_RUNTIME_DIR,
    XDG_CONFIG_HOME: "/home/browser/.config",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${BROWSER_RUNTIME_DIR}/session-bus`,
  };
  const streaming: NodeJS.ProcessEnv = {
    ...common,
    SELKIES_ADDR: "127.0.0.1",
    CUSTOM_WS_PORT: "8080",
    SELKIES_ENABLE_BASIC_AUTH: "false|locked",
    // The authenticated daemon recorder uses Selkies' read-only viewer role. The
    // shared-client gate must admit it; interactive collaboration remains disabled.
    SELKIES_ENABLE_SHARED: "true|locked",
    SELKIES_MODE: "websockets",
    SELKIES_MANUAL_WIDTH: String(width),
    SELKIES_MANUAL_HEIGHT: String(height),
    SELKIES_SCALING_DPI: "96",
    SELKIES_ENCODER: "h264enc",
    // Frame rate and quality stay open for the daemon's stream tuner, whose own video starts off.
    SELKIES_FRAMERATE: "60,10-60",
    SELKIES_VIDEO_ON_START: "false",
    SELKIES_USE_PAINT_OVER_QUALITY: "true",
    SELKIES_VIDEO_FULLCOLOR: `${checked.data.fullcolor}|locked`,
    SELKIES_ENABLE_CLIPBOARD: "false",
    SELKIES_FILE_TRANSFERS: "none",
    SELKIES_MANUAL_RESOLUTION: "true|locked",
  };
  for (const name of [
    "audio_enabled",
    "microphone_enabled",
    "gamepad_enabled",
    "webcam_enabled",
    "enable_binary_clipboard",
    "printing_enabled",
    "command_enabled",
    "enable_resize",
    "enable_cursors",
    "use_css_scaling",
    "enable_dual_mode",
    "enable_sharing",
    "enable_collab",
    "enable_player2",
    "enable_player3",
    "enable_player4",
    "ui_show_logo",
    "ui_show_core_buttons",
    "ui_show_sidebar",
    "wayland",
    "enable_cloudflare_turn",
  ])
    streaming[`SELKIES_${name.toUpperCase()}`] = "false|locked";
  return Object.freeze({
    display: spec(
      "/usr/bin/Xvfb",
      [
        BROWSER_DISPLAY,
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-dpi",
        "96",
        "-nolisten",
        "tcp",
        "-ac",
        "-noreset",
        "+extension",
        "XTEST",
        "+extension",
        "XFIXES",
        "+extension",
        "RANDR",
      ],
      common,
    ),
    dbus: spec(
      "/usr/bin/dbus-daemon",
      ["--session", "--nofork", "--nopidfile", `--address=${common.DBUS_SESSION_BUS_ADDRESS}`],
      common,
    ),
    windowManager: spec("/usr/bin/xfwm4", ["--compositor=off"], common),
    stream: spec("/lsiopy/bin/selkies", [], streaming),
    streamProxy: spec(
      "/usr/sbin/nginx",
      ["-p", BROWSER_RUNTIME_DIR, "-c", "/etc/localdot/browser-nginx.conf"],
      common,
    ),
    forwarder: spec("/usr/local/bin/node", ["/opt/localdot/forwarder.mjs"], {
      ...common,
      LOCALDOT_GATE_ADDR: checked.data.gateAddress,
      LOCALDOT_GATE_PORT: "3128",
      LOCALDOT_FORWARDER_PORT: "3129",
      LOCALDOT_PROXY_TOKEN_FILE: "/etc/localdot/cell/proxy-token",
    }),
    xhelper: spec("/usr/bin/python3", ["-u", "/opt/localdot/browser-helper.py"], common, "stdio"),
    capture: spec("/usr/bin/python3", ["-u", "/opt/localdot/browser-capture.py"], common, "stdio"),
    chromium: spec(
      "/usr/lib/chromium/chromium",
      [
        "--ozone-platform=x11",
        "--window-size=1280,800",
        `--force-device-scale-factor=${scale}`,
        "--start-maximized",
        "--remote-debugging-pipe",
        "--force-renderer-accessibility",
        `--user-data-dir=${BROWSER_PROFILE_DIR}`,
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-quic",
        "--disable-extensions",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--password-store=basic",
        "--proxy-server=http://127.0.0.1:3129",
        "--proxy-bypass-list=<-loopback>",
        "about:blank",
      ],
      { ...common, ACCESSIBILITY_ENABLED: "1" },
      "cdp",
    ),
  });
}
