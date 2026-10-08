import { userInfo } from "node:os";
import { serve } from "@hono/node-server";
import { createDesktopdApp, monoNow } from "./app.ts";
import { MIN_TOKEN_LENGTH } from "./auth.ts";
import { prepareDesktopBrowser } from "./browser-profile.ts";
import { launchApp } from "./launch.ts";
import { ChromiumPerception } from "./perception/cdp.ts";
import { CuaDriver } from "./perception/driver.ts";
import { driverInjector } from "./perception/find.ts";
import type { PerceptionDeps } from "./perception/hit-test.ts";
import { AtspiAccessibility } from "./perception/native.ts";
import { cachedSelfTest, nodeProbes, runSelfTest, selfTestConfigFromEnv } from "./selftest.ts";
import { PageBrowser } from "./tools/browser.ts";
import { startXHelper, type XHelper } from "./x/helper.ts";
import { readScreen, readXsettings } from "./xsettings.ts";

const token = process.env.LOCALDOT_DESKTOPD_TOKEN ?? "";
if (token.length < MIN_TOKEN_LENGTH) {
  console.error(
    `desktopd: LOCALDOT_DESKTOPD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
  );
  process.exit(1);
}
const scale = process.env.LOCALDOT_SCALE === "1" ? 1 : 2;
const port = Number(process.env.LOCALDOT_DESKTOPD_PORT ?? 7700);
// desktopd runs as the session's user, so its own uid is the session's.
const uid = userInfo().uid;
const XHELPER = process.env.LOCALDOT_XHELPER ?? "/opt/localdot/xhelper.py";

// Complete interrupted retirement before exposing desktopd or accepting a new task.
await prepareDesktopBrowser(null);

// The helper is restarted after a crash; routes answer 503 in between. One start at a time: the
// 2 s retry must not spawn a second helper while the first is still inside its 5 s ready wait.
let x: XHelper | undefined;
let starting: Promise<XHelper | undefined> | undefined;
function ensureHelper(): Promise<XHelper | undefined> {
  if (x?.alive) return Promise.resolve(x);
  if (starting) return starting;
  starting = (async () => {
    try {
      // /usr/bin/python3: the base image's PATH starts with a venv (/lsiopy) without python-xlib.
      x = await startXHelper({
        command: "/usr/bin/python3",
        args: ["-u", XHELPER],
        env: process.env,
      });
      console.log("desktopd: x helper ready");
    } catch (err) {
      console.error(
        `desktopd: x helper failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      x = undefined;
    } finally {
      starting = undefined;
    }
    return x;
  })();
  return starting;
}
await ensureHelper();
setInterval(() => void ensureHelper(), 2000).unref();

const driver = new CuaDriver(CuaDriver.defaultOptions());
const native = new AtspiAccessibility();
const cdp = new ChromiumPerception({
  originProvider: async (win) => {
    const doc = await native.query(win, "content");
    return doc?.frame ? { x: doc.frame.x, y: doc.frame.y } : undefined;
  },
});
const scaling = async () => {
  const settings = await readXsettings(uid);
  return settings === null ? scale : (settings.windowScalingFactor ?? 1);
};
const app = createDesktopdApp({
  prepareBrowser: prepareDesktopBrowser,
  tools: {
    home: process.env.LOCALDOT_HOME_DIR ?? "/config",
    env: process.env,
    browser: new PageBrowser(),
  },
  selfTest: cachedSelfTest(() => runSelfTest(selfTestConfigFromEnv(process.env), nodeProbes())),
  token,
  scale,
  display: process.env.DISPLAY ?? ":1",
  readXsettings: () => readXsettings(uid),
  readScreen,
  get x() {
    return x;
  },
  launch: (req) => launchApp(req, process.env),
  clockMono: monoNow,
  get perception(): PerceptionDeps | undefined {
    return x ? { x, driver, native, cdp, scale, readScaling: scaling } : undefined;
  },
  get injectors() {
    return x
      ? { xtest: true as const, driver: driverInjector(driver, x) }
      : { xtest: true as const };
  },
});
// 0.0.0.0 inside the cell: only the gate's relay on the isolated internal network can reach it.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`desktopd on 0.0.0.0:${port} (scale ${scale})`);
});
