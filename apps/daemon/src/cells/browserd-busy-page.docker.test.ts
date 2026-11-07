import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { FIRST_LOOK_MS } from "../agent/wiring.ts";
import { BrowserClient } from "../browser/client.ts";
import { browserGatewayDevice } from "../browser/gateway-device.ts";
import {
  ScreenController,
  type ScreenControllerDeps,
  type ScreenLease,
  type ScreenScope,
} from "../browser/screen-controller.ts";
import type { ReadyBrowser } from "./browser-orchestrator.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// A browser cell with the live cell's four CPUs, on a page whose main thread is busy for most of
// every frame while it repaints a full-window canvas, driven by the daemon's own screen owner: a
// user's takeover and hand-back, then a task's first look. No keyd, no live computer.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.233.91";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const SITE = "http://busy.localdot.test";

// Every frame holds the main thread for `busy` ms, as a heavy feed does for seconds at a time:
// anything browserd asks of the page waits for the frame to end. It is busy from `after` ms past its
// load, as a feed that starts playing once the user is signed in.
const PAGE = `<!doctype html><title>Busy page</title><style>
html, body { margin: 0; height: 100%; overflow: hidden; }
canvas { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; }
</style><body><canvas></canvas><script>
const params = new URLSearchParams(location.search);
const busy = Number(params.get("busy"));
const canvas = document.querySelector("canvas");
const paint = canvas.getContext("2d");
let frame = 0;
function draw() {
  const width = innerWidth * devicePixelRatio, height = innerHeight * devicePixelRatio;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  for (let i = 0; i < 64; i++) {
    paint.fillStyle = "hsl(" + ((frame * 13 + i * 29) % 360) + ",70%,50%)";
    paint.fillRect(((i % 8) * width) / 8, (Math.floor(i / 8) * height) / 8, width / 8, height / 8);
  }
  frame++;
  const until = performance.now() + busy;
  while (performance.now() < until) {}
  requestAnimationFrame(draw);
}
addEventListener("load", () => setTimeout(() => requestAnimationFrame(draw), Number(params.get("after"))));
</script></body>`;

const GATE = `
import http.server
page = ${JSON.stringify(PAGE)}.encode()
class Gate(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(32).toString("base64url");
function caCertificate(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-browser-ca-"));
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localdot test gate",
      "-days",
      "1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "ca.pem"),
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    return readFileSync(join(dir, "ca.pem"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!DOCKER_TESTS)("a task's first look at a web browser on a busy page", () => {
  const names = scope && {
    network: `${scope.namePrefix}busy-net`,
    gate: `${scope.namePrefix}busy-gate`,
    browser: `${scope.namePrefix}busy-browser`,
  };
  let attached: ChildProcess | undefined;
  let endpoint: ReadyBrowser;
  // What the screen owner asked of browserd, and how long each took.
  const calls: string[] = [];
  const timed = (client: BrowserClient) =>
    new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!["ownTabs", "clock", "control", "enterWindow", "read"].includes(String(key)))
          return value.bind(target);
        return async (...args: unknown[]) => {
          const started = performance.now();
          const took = () => Math.round(performance.now() - started);
          try {
            const result = await value.apply(target, args);
            calls.push(`${String(key)} ${took()} ms`);
            return result;
          } catch (error) {
            calls.push(
              `${String(key)} ${(error as { code?: string }).code ?? "failed"} ${took()} ms`,
            );
            throw error;
          }
        };
      },
    });
  const removeAll = () => {
    if (!names) return;
    for (const name of [names.browser, names.gate])
      execFileSync("sh", ["-c", `docker rm -fv ${name} >/dev/null 2>&1 || true`]);
    execFileSync("sh", ["-c", `docker network rm ${names.network} >/dev/null 2>&1 || true`]);
  };

  beforeAll(() => {
    if (!scope || !names) return;
    removeAll();
    docker(
      "network",
      "create",
      "--label",
      scope.label,
      "--subnet",
      `${SUBNET}.0/24`,
      names.network,
    );
    docker(
      "run",
      "-d",
      "--name",
      names.gate,
      "--label",
      scope.label,
      "--memory",
      "128m",
      "--network",
      names.network,
      "--ip",
      `${SUBNET}.2`,
      "--entrypoint",
      "/usr/bin/python3",
      DESKTOP_IMAGE,
      "-c",
      GATE,
    );
  });

  afterAll(removeAll);

  // A browser of each test's own: a page left busy would slow the next test's grants.
  beforeEach(async () => {
    if (!scope || !names) return;
    execFileSync("sh", ["-c", `docker rm -fv ${names.browser} >/dev/null 2>&1 || true`]);
    const browserCellId = ulid();
    const parentCellId = ulid();
    const serviceToken = token();
    docker(
      "create",
      "-i",
      "--name",
      names.browser,
      "--label",
      scope.label,
      "--memory",
      "2g",
      "--cpus",
      "4",
      "--network",
      names.network,
      "--ip",
      `${SUBNET}.3`,
      "-p",
      "127.0.0.1::7700",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${SECCOMP}`,
      "--init",
      "--shm-size",
      String(512 * 1024 ** 2),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777",
      "--tmpfs",
      "/downloads:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/config:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/home/browser:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/etc/localdot/cell:rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/profile:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
      "-e",
      `LOCALDOT_BROWSER_CELL_ID=${browserCellId}`,
      "-e",
      `LOCALDOT_PARENT_CELL_ID=${parentCellId}`,
      "-e",
      `LOCALDOT_BROWSERD_TOKEN=${serviceToken}`,
      "-e",
      `LOCALDOT_STREAM_TOKEN=${token()}`,
      "-e",
      `LOCALDOT_GATE_ADDR=${SUBNET}.2`,
      "-e",
      "LOCALDOT_SCALE=2",
      "-e",
      "LOCALDOT_STREAM_FULLCOLOR=0",
      IMAGE,
    );
    attached = spawn("docker", ["start", "-a", "-i", names.browser], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    attached.stdin?.end(
      JSON.stringify({
        v: 1,
        browserCellId,
        parentCellId,
        proxyToken: token(),
        caCertPem: caCertificate(),
      }),
    );
    let port = 0;
    for (let i = 0; i < 60 && !port; i++) {
      try {
        port = publishedPort(names.browser, "7700");
      } catch {
        await sleep(500);
      }
    }
    if (!port) throw new Error("browserd is not published");
    const baseUrl = `http://127.0.0.1:${port}`;
    let instance = "";
    for (const deadline = Date.now() + 120_000; Date.now() < deadline && !instance; ) {
      try {
        const res = await fetch(`${baseUrl}/health`, {
          headers: { authorization: `Bearer ${serviceToken}` },
          signal: AbortSignal.timeout(3000),
        });
        const body = (await res.json()) as { ready?: boolean; instance?: string };
        if (res.ok && body.ready && body.instance) instance = body.instance;
      } catch {
        // browserd is still starting
      }
      if (!instance) await sleep(1000);
    }
    if (!instance) throw new Error("browserd did not become ready");
    endpoint = {
      browserCellId,
      parentCellId,
      instance,
      browserd: { baseUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    };
  }, 240_000);

  afterEach(() => {
    attached?.kill();
    if (names) execFileSync("sh", ["-c", `docker rm -fv ${names.browser} >/dev/null 2>&1 || true`]);
  });

  // A task of its own on the browser, as the daemon runs one: the controller, its scopes and what it
  // reported for the daemon's log.
  const task = () => {
    const sessionId = ulid();
    const reports: string[] = [];
    const abort = new AbortController();
    const deps = {
      sessionId,
      parentCellId: endpoint.parentCellId,
      desktopGeometry: { w: 2560, h: 1600, scale: 2 as const },
      desktopReady: () => true,
      browser: {
        start: async () => endpoint,
        endpoints: () => endpoint,
        get: () => undefined,
        stop: async () => {
          reports.push("stopped the browser");
        },
      },
      client: (ready: ReadyBrowser) => timed(new BrowserClient(ready)),
      report: (message: string) => reports.push(message),
      attachRecording: async () => {},
      fenceRecording: async () => {},
      publish: () => {},
      fenceSession: () => reports.push("fenced the session"),
      contain: async () => {
        reports.push("contained the session");
      },
    } satisfies ScreenControllerDeps;
    const controller = new ScreenController(deps);
    const at = (generation: number): ScreenScope => ({
      sessionId,
      generation,
      signal: abort.signal,
      check: () => abort.signal.throwIfAborted(),
    });
    const open = async (query: string) => {
      await controller.switchTo("browser", at(1));
      const lease = controller.lease(at(1));
      try {
        const { client, permit, tabId } = controller.browserAccess(lease);
        await client.navigate(permit, tabId, `${SITE}/feed?${query}`, lease);
      } finally {
        lease.finish();
      }
    };
    // What the gateway does before a screenshot or an action: map the browser's clock.
    const clock = (lease: ScreenLease) =>
      browserGatewayDevice({
        ...controller.browserAccess(lease),
        lease,
        now: () => Math.round((performance.timeOrigin + performance.now()) * 1000),
      });
    const end = async () => {
      abort.abort();
      await controller.cancel().catch(() => {});
    };
    return { controller, at, open, clock, end, reports };
  };

  // The incident: the user signs in on a page that then keeps its main thread busy, hands the
  // browser back, and the task's next brain takes its first look, then reads on.
  it("hands a busy page back to the task, and finds it in front though it answers in seconds", async () => {
    const busy = 3500;
    const t = task();
    try {
      const opened = performance.now();
      await t.open(`busy=${busy}&after=8000`);
      await t.controller.takeOver();
      const manual = t.controller.manualAccess(t.at(1));
      try {
        await manual.input({ kind: "click", at: { x: 640, y: 500 }, button: "left", count: 1 });
      } finally {
        manual.finish();
      }
      const back = await t.controller.activate(t.at(2));
      expect(back.screen, t.reports.join("; ")).toBe("browser");
      expect(performance.now() - opened).toBeLessThan(8000);
      await sleep(8000 + 3 * busy - (performance.now() - opened));
      calls.length = 0;
      const step = async (what: string, work: (lease: ScreenLease) => Promise<unknown>) => {
        const lease = t.controller.lease(t.at(2));
        try {
          await work(lease);
        } catch (error) {
          throw new Error(`${what}: ${(error as Error).message} (${calls.join(", ")})`);
        } finally {
          lease.finish();
        }
      };
      // The first look finds the page in front, as a read after it does, back to back.
      await step("first look", (lease) => t.controller.refreshBrowser(lease));
      await step("a later read", (lease) => t.controller.refreshBrowser(lease));
      // The gateway maps the browser's clock before a screenshot or an action.
      await step("the gateway's clock", (lease) => t.clock(lease).clocks.sync());
      // The page kept browserd waiting past the search's old six seconds.
      expect(
        calls.some((call) => /^clock \d+ ms$/u.test(call) && Number(call.split(" ")[1]) > 6000),
        calls.join(", "),
      ).toBe(true);
      expect(t.reports).toEqual([]);
    } finally {
      await t.end();
    }
  }, 240_000);

  it("takes a task's whole first look at a page busy for most of every frame, in the time it has", async () => {
    const busy = 700;
    const t = task();
    try {
      await t.open(`busy=${busy}&after=0`);
      await sleep(1000 + 3 * busy);
      calls.length = 0;
      const started = performance.now();
      const lease = t.controller.lease(t.at(1));
      try {
        await t.controller.refreshBrowser(lease);
        const device = t.clock(lease);
        await device.clocks.sync();
        const frame = await device.client.observe(lease.signal);
        expect(frame.image.length).toBeGreaterThan(1000);
      } finally {
        lease.finish();
      }
      expect(performance.now() - started, calls.join(", ")).toBeLessThan(FIRST_LOOK_MS);
      expect(t.reports).toEqual([]);
    } finally {
      await t.end();
    }
  }, 240_000);
});
