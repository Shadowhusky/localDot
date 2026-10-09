import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type ExportHostCheck, type HostExport, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { CdpPipe } from "./cdp.ts";
import { type Browser, browserCandidates, ChromeRenderer } from "./chrome.ts";
import { ExportFailure, type RenderIo } from "./jobs.ts";
import { ABLE } from "./testing/fake-renderer.ts";

type Emit = (method: string, params: Record<string, unknown>) => void;

interface FakePage {
  check?: ExportHostCheck;
  // Runs when the daemon asks the page to make the video.
  run?(page: { send(message: unknown): void; acked(seq: number): Promise<void> }): void;
}

// A browser on the far side of a debugging pipe, answering the calls an export makes.
function fakeBrowser(page: FakePage) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new CdpPipe(toBrowser, fromBrowser);
  const acks = new Map<number, () => void>();
  const acked = new Set<number>();
  const expressions: string[] = [];
  let exit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const write = (message: Record<string, unknown>) =>
    fromBrowser.write(`${JSON.stringify(message)}\0`);
  const emit: Emit = (method, params) => write({ method, params, sessionId: "S" });
  let pending = "";
  toBrowser.on("data", (data: Buffer) => {
    pending += data.toString();
    for (let end = pending.indexOf("\0"); end >= 0; end = pending.indexOf("\0")) {
      const message = JSON.parse(pending.slice(0, end)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      pending = pending.slice(end + 1);
      const reply = (result: Record<string, unknown> = {}) => write({ id: message.id, result });
      switch (message.method) {
        case "Target.createTarget":
          reply({ targetId: "T" });
          break;
        case "Target.attachToTarget":
          reply({ sessionId: "S" });
          break;
        case "Page.navigate":
          reply({ frameId: "F" });
          setTimeout(() => emit("Page.loadEventFired", {}), 0);
          break;
        case "Runtime.evaluate": {
          const expression = String(message.params.expression);
          expressions.push(expression);
          const ack = /\.ack\((\d+)\)/.exec(expression);
          if (ack) {
            acked.add(Number(ack[1]));
            acks.get(Number(ack[1]))?.();
          }
          reply({ result: { value: expression.includes("check()") ? page.check : undefined } });
          if (expression.includes(".run("))
            page.run?.({
              send: (payload) =>
                emit("Runtime.bindingCalled", {
                  name: "localdotExport",
                  payload: JSON.stringify(payload),
                }),
              acked: (seq) =>
                acked.has(seq)
                  ? Promise.resolve()
                  : new Promise((resolve) => acks.set(seq, resolve)),
            });
          break;
        }
        case "Browser.close":
          reply();
          fromBrowser.end();
          exit();
          break;
        default:
          reply();
      }
    }
  });
  const close = vi.fn(async () => {
    if (!toBrowser.writableEnded) {
      await cdp.send("Browser.close").catch(() => {});
    }
    await exited;
  });
  const browser: Browser = { cdp, exited, close };
  return {
    browser,
    expressions,
    crash() {
      fromBrowser.end();
      exit();
    },
  };
}

function job(): HostExport {
  const sessionId = ulid();
  return {
    id: ulid(),
    sessionId,
    screen: "desktop",
    name: "localdot-2026-10-09-1504.mp4",
    phase: "making",
    createdAt: 0,
    done: 0,
    total: 0,
    elapsedMs: 0,
    leftMs: null,
    bytes: 0,
    durationS: null,
    error: null,
    request: {
      sessionId,
      fromMs: 0,
      toMs: 1000,
      speed: 1,
      skipIdle: false,
      captions: true,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps: 30,
      quality: "high",
      format: "mp4",
    },
  };
}

function recorder() {
  const writes: { position: number; data: number[] }[] = [];
  const progress: [number, number][] = [];
  const io: RenderIo = {
    progress: (done, total) => void progress.push([done, total]),
    write: async (position, data) => void writes.push({ position, data: [...data] }),
  };
  return { io, writes, progress };
}

describe("browserCandidates", () => {
  const sources = (platform: NodeJS.Platform, present: string[], env: NodeJS.ProcessEnv = {}) => ({
    env,
    platform,
    home: "/Users/me",
    exists: (path: string) => present.includes(path),
    list: (dir: string) =>
      dir === "/Users/me/Library/Caches/ms-playwright" || dir === "/home/me/.cache/ms-playwright"
        ? ["chromium-1208", "chromium_headless_shell-1243", "chromium-1243", "ffmpeg-1011"]
        : [],
  });

  it("tries the installed browsers first, then Playwright's newest", () => {
    const cache = "/Users/me/Library/Caches/ms-playwright";
    const testing =
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    const present = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      join(cache, "chromium-1208", testing),
      join(cache, "chromium-1243", testing),
      join(
        cache,
        "chromium_headless_shell-1243",
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
    ];
    expect(browserCandidates(sources("darwin", present))).toEqual([
      present[0],
      present[1],
      present[3],
      present[4],
      present[2],
    ]);
  });

  it("finds Chrome or Chromium on a Linux server", () => {
    expect(
      browserCandidates({
        ...sources("linux", ["/usr/bin/chromium"]),
        home: "/home/me",
      }),
    ).toEqual(["/usr/bin/chromium"]);
  });

  it("uses only the browser LOCALDOT_EXPORT_BROWSER names", () => {
    const named = { LOCALDOT_EXPORT_BROWSER: "/opt/chrome" };
    expect(
      browserCandidates(sources("linux", ["/opt/chrome", "/usr/bin/chromium"], named)),
    ).toEqual(["/opt/chrome"]);
    expect(browserCandidates(sources("linux", ["/usr/bin/chromium"], named))).toEqual([]);
  });
});

describe("ChromeRenderer.check", () => {
  it("falls back from a browser that won't start or can't decode to one that can", async () => {
    const broken = fakeBrowser({ check: { ...ABLE, decodes: false } });
    const able = fakeBrowser({ check: ABLE });
    const launch = vi.fn(async (path: string) => {
      if (path === "/missing") throw new Error("ENOENT");
      return path === "/old" ? broken.browser : able.browser;
    });
    const renderer = new ChromeRenderer({
      origin: "http://127.0.0.1:4750",
      token: "a".repeat(43),
      candidates: () => ["/missing", "/old", "/chrome"],
      launch,
    });
    expect(await renderer.check()).toEqual(ABLE);
    expect(renderer.browser).toBe("/chrome");
    expect(broken.browser.close).toHaveBeenCalled();
    expect(able.browser.close).toHaveBeenCalled();
    expect(able.expressions).toEqual(["window.__localdotExportHost.check()"]);
  });

  it("reports no renderer when no browser can make videos", async () => {
    const renderer = new ChromeRenderer({
      origin: "http://127.0.0.1:4750",
      token: "a".repeat(43),
      candidates: () => ["/nowebgl"],
      launch: async () => fakeBrowser({ check: { ...ABLE, graphics: null } }).browser,
    });
    expect(await renderer.check()).toBeNull();
    expect(renderer.browser).toBeNull();
    await expect(
      renderer.render(job(), recorder().io, new AbortController().signal),
    ).rejects.toThrow(ExportFailure);
  });
});

describe("ChromeRenderer.render", () => {
  async function rendererFor(page: FakePage, stallMs?: number) {
    const made = fakeBrowser(page);
    let first = true;
    const renderer = new ChromeRenderer({
      origin: "http://127.0.0.1:4750",
      token: "a".repeat(43),
      candidates: () => ["/chrome"],
      launch: async () => {
        if (first) {
          first = false;
          return fakeBrowser({ check: ABLE }).browser;
        }
        return made.browser;
      },
      ...(stallMs ? { stallMs } : {}),
    });
    await renderer.check();
    return { renderer, made };
  }

  it("writes each chunk where the page says, acknowledges it, and finishes", async () => {
    const { renderer, made } = await rendererFor({
      async run(page) {
        page.send({ type: "progress", done: 15, total: 30 });
        page.send({
          type: "chunk",
          seq: 0,
          position: 4,
          data: Buffer.from([5, 6]).toString("base64"),
        });
        await page.acked(0);
        page.send({
          type: "chunk",
          seq: 1,
          position: 0,
          data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        });
        await page.acked(1);
        page.send({ type: "done", frames: 30, bytes: 6 });
      },
    });
    const { io, writes, progress } = recorder();
    const exporting = job();
    expect(await renderer.render(exporting, io, new AbortController().signal)).toEqual({
      frames: 30,
    });
    expect(progress).toEqual([[15, 30]]);
    expect(writes).toEqual([
      { position: 4, data: [5, 6] },
      { position: 0, data: [1, 2, 3, 4] },
    ]);
    const run = made.expressions.find((expression) => expression.includes(".run("));
    expect(run).toContain(`"sessionId":"${exporting.sessionId}"`);
    expect(run).toContain('"screen":"desktop"');
    expect(made.browser.close).toHaveBeenCalled();
  });

  it("fails with the page's own words", async () => {
    const { renderer, made } = await rendererFor({
      run(page) {
        page.send({ type: "error", message: "The recording could not be exported." });
      },
    });
    await expect(
      renderer.render(job(), recorder().io, new AbortController().signal),
    ).rejects.toThrow("The recording could not be exported.");
    expect(made.browser.close).toHaveBeenCalled();
  });

  it("gives up on a page that stops talking", async () => {
    const { renderer } = await rendererFor({ run() {} }, 50);
    await expect(
      renderer.render(job(), recorder().io, new AbortController().signal),
    ).rejects.toThrow("The video stopped being made. Try again.");
  });

  it("fails when the browser goes away", async () => {
    let crash = () => {};
    const { renderer, made } = await rendererFor({
      run(page) {
        page.send({ type: "progress", done: 1, total: 30 });
        setTimeout(() => crash(), 0);
      },
    });
    crash = made.crash;
    await expect(
      renderer.render(job(), recorder().io, new AbortController().signal),
    ).rejects.toThrow("The video couldn't be made. Try again.");
  });

  it("stops when cancelled and closes the browser", async () => {
    const abort = new AbortController();
    const { renderer, made } = await rendererFor({
      run(page) {
        page.send({ type: "progress", done: 1, total: 30 });
        setTimeout(() => abort.abort(new DOMException("cancelled", "AbortError")), 0);
      },
    });
    await expect(renderer.render(job(), recorder().io, abort.signal)).rejects.toThrow("cancelled");
    expect(made.browser.close).toHaveBeenCalled();
  });

  it("refuses a malformed message", async () => {
    const { renderer } = await rendererFor({
      run(page) {
        page.send({ type: "chunk", seq: 0, position: -1, data: "" });
      },
    });
    await expect(
      renderer.render(job(), recorder().io, new AbortController().signal),
    ).rejects.toThrow(ExportFailure);
  });
});
