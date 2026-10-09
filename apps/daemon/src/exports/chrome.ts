import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  EXPORT_CHUNK_BYTES,
  ExportHostCheck,
  ExportPageMessage,
  type HostExport,
} from "@localdot/protocol";
import { CdpPipe } from "./cdp.ts";
import {
  ExportFailure,
  type ExportRenderer,
  NO_RENDERER,
  type RenderIo,
  type RenderResult,
} from "./jobs.ts";

export const EXPORT_PAGE = "/export.html";
const BINDING = "localdotExport";
const LOAD_MS = 30_000;
// A page that sends nothing for this long has stopped.
const STALL_MS = 120_000;
const STALLED = "The video stopped being made. Try again.";
const FAILED = "The video couldn't be made. Try again.";

// Without a GPU (a Linux server), WebGL still works in software: the page is our own, so the
// software rasteriser's exposure to untrusted shaders does not apply.
const FLAGS = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--password-store=basic",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-breakpad",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--mute-audio",
  "--enable-unsafe-swiftshader",
];

const SYSTEM_BROWSERS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ],
};

// Inside a Playwright download of Chromium, newest first: a developer's or a server's fallback.
const PLAYWRIGHT_BINARIES = [
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-linux64/chrome",
  "chrome-linux/chrome",
  "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "chrome-headless-shell-mac-x64/chrome-headless-shell",
  "chrome-headless-shell-linux64/chrome-headless-shell",
];

export interface CandidateSources {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): boolean;
  list(dir: string): string[];
}

const LOCAL: CandidateSources = {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

// The browsers that may make videos, in the order they are tried: the one named by
// LOCALDOT_EXPORT_BROWSER alone, else the installed Chrome-family browsers, then Playwright's.
export function browserCandidates(sources: CandidateSources = LOCAL): string[] {
  const named = sources.env.LOCALDOT_EXPORT_BROWSER;
  if (named) return sources.exists(named) ? [named] : [];
  const system = (SYSTEM_BROWSERS[sources.platform] ?? []).map((path) =>
    path.startsWith("~/") ? join(sources.home, path.slice(2)) : path,
  );
  const cache =
    sources.env.PLAYWRIGHT_BROWSERS_PATH ||
    (sources.platform === "darwin"
      ? join(sources.home, "Library", "Caches", "ms-playwright")
      : join(sources.home, ".cache", "ms-playwright"));
  const revision = (name: string) => Number(name.slice(name.lastIndexOf("-") + 1));
  const downloads = sources
    .list(cache)
    .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort(
      (a, b) =>
        revision(b) - revision(a) ||
        Number(a.includes("headless")) - Number(b.includes("headless")),
    )
    .flatMap((name) => PLAYWRIGHT_BINARIES.map((binary) => join(cache, name, binary)));
  return [...system, ...downloads].filter((path) => sources.exists(path));
}

export interface Browser {
  cdp: CdpPipe;
  exited: Promise<void>;
  close(): Promise<void>;
}

export type LaunchBrowser = (path: string, extra?: readonly string[]) => Promise<Browser>;

// A private profile per launch, removed when the browser closes. The pipe closing (the daemon
// gone) makes the browser quit too.
export const launchBrowser: LaunchBrowser = async (path, extra = []) => {
  const profile = mkdtempSync(join(tmpdir(), "localdot-export-"));
  const child = spawn(path, [...FLAGS, `--user-data-dir=${profile}`, ...extra, "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  child.on("error", () => {});
  const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let closing: Promise<void> | undefined;
  return {
    cdp,
    exited,
    close() {
      closing ??= (async () => {
        const quit = setTimeout(() => child.kill("SIGKILL"), 3000);
        await Promise.race([cdp.send("Browser.close").catch(() => {}), exited]);
        await exited;
        clearTimeout(quit);
        rmSync(profile, { recursive: true, force: true });
      })();
      return closing;
    },
  };
};

export interface ExportPage {
  evaluate(expression: string): Promise<unknown>;
  // The page crashed or went away.
  gone: Promise<void>;
}

export async function openExportPage(
  cdp: CdpPipe,
  url: string,
  onMessage?: (payload: string) => void,
): Promise<ExportPage> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string;
  };
  const gone = new Promise<void>((resolve) => {
    cdp.on("Inspector.targetCrashed", (_params, from) => {
      if (from === sessionId) resolve();
    });
    cdp.on("Target.detachedFromTarget", (params) => {
      if (params.sessionId === sessionId) resolve();
    });
    cdp.onClose(() => resolve());
  });
  if (onMessage)
    cdp.on("Runtime.bindingCalled", (params, from) => {
      if (from === sessionId && params.name === BINDING && typeof params.payload === "string")
        onMessage(params.payload);
    });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Runtime.addBinding", { name: BINDING }, sessionId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    const off = cdp.on("Page.loadEventFired", (_params, from) => {
      if (from !== sessionId) return;
      off();
      resolve();
    });
    timer = setTimeout(() => reject(new Error("The export page did not load.")), LOAD_MS);
    void gone.then(() => reject(new Error("The export page went away.")));
  });
  try {
    const navigated = await cdp.send("Page.navigate", { url }, sessionId);
    if (typeof navigated.errorText === "string" && navigated.errorText)
      throw new Error("The export page did not load.");
    await loaded;
  } finally {
    clearTimeout(timer);
  }
  return {
    gone,
    async evaluate(expression) {
      const reply = (await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (reply.exceptionDetails) throw new Error("The export page refused the call.");
      return reply.result?.value;
    },
  };
}

export interface ChromeRendererOptions {
  // The daemon's own address, which serves the export page and the recordings.
  origin: string;
  token: string;
  candidates?: () => string[];
  launch?: LaunchBrowser;
  stallMs?: number;
}

// Makes each video in a headless browser on this computer, running the same export code a viewer's
// page runs (the picture, overlays and captions drawn with WebGL, encoded with WebCodecs), so a
// video comes out the same wherever it was asked for.
export class ChromeRenderer implements ExportRenderer {
  readonly #options: ChromeRendererOptions;
  #chosen: string | null = null;

  constructor(options: ChromeRendererOptions) {
    this.#options = options;
  }

  get browser(): string | null {
    return this.#chosen;
  }

  async check() {
    const launch = this.#options.launch ?? launchBrowser;
    for (const path of (this.#options.candidates ?? browserCandidates)()) {
      let browser: Browser | undefined;
      try {
        browser = await launch(path);
        const page = await openExportPage(browser.cdp, `${this.#options.origin}${EXPORT_PAGE}`);
        const found = ExportHostCheck.parse(
          await page.evaluate("window.__localdotExportHost.check()"),
        );
        if (found.decodes && found.graphics !== null && found.maxPixels.mp4 > 0) {
          this.#chosen = path;
          return found;
        }
      } catch {
        // The next browser is tried.
      } finally {
        await browser?.close();
      }
    }
    this.#chosen = null;
    return null;
  }

  async render(job: HostExport, io: RenderIo, signal: AbortSignal): Promise<RenderResult> {
    const path = this.#chosen;
    if (!path) throw new ExportFailure(NO_RENDERER);
    signal.throwIfAborted();
    const browser = await (this.#options.launch ?? launchBrowser)(path);
    let stall: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<RenderResult>((resolve, reject) => {
        let settled = false;
        const abort = () => finish(signal.reason);
        const finish = (error: unknown, result?: RenderResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(stall);
          signal.removeEventListener("abort", abort);
          if (result) resolve(result);
          else reject(error);
        };
        const watch = () => {
          clearTimeout(stall);
          stall = setTimeout(
            () => finish(new ExportFailure(STALLED)),
            this.#options.stallMs ?? STALL_MS,
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        let page: ExportPage | undefined;
        let queue = Promise.resolve();
        const handle = async (message: ExportPageMessage) => {
          if (message.type === "progress") io.progress(message.done, message.total);
          else if (message.type === "chunk") {
            const data = Buffer.from(message.data, "base64");
            if (data.byteLength > EXPORT_CHUNK_BYTES) throw new Error("oversized chunk");
            await io.write(message.position, data);
            await page?.evaluate(`window.__localdotExportHost.ack(${message.seq})`);
          } else if (message.type === "done") finish(null, { frames: message.frames });
          else finish(new ExportFailure(message.message));
        };
        const receive = (payload: string) => {
          watch();
          let message: ExportPageMessage;
          try {
            message = ExportPageMessage.parse(JSON.parse(payload));
          } catch {
            finish(new ExportFailure(FAILED));
            return;
          }
          queue = queue.then(() => (settled ? undefined : handle(message))).catch(finish);
        };
        watch();
        void browser.exited.then(() => finish(new ExportFailure(FAILED)));
        openExportPage(browser.cdp, `${this.#options.origin}${EXPORT_PAGE}`, receive)
          .then((opened) => {
            page = opened;
            void opened.gone.then(() => finish(new ExportFailure(FAILED)));
            const spec = {
              token: this.#options.token,
              screen: job.screen,
              request: job.request,
            };
            return opened.evaluate(`window.__localdotExportHost.run(${JSON.stringify(spec)})`);
          })
          .catch(() => finish(new ExportFailure(FAILED)));
      });
    } finally {
      clearTimeout(stall);
      await browser.close();
    }
  }
}
