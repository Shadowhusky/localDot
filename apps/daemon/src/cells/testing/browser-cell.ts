import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import type {
  BrowserActionPermit,
  BrowserLifecycleRequest,
} from "../../../../../packages/protocol/src/browser-control.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "../../browser/client.ts";
import { docker, publishedPort } from "./docker-cli.ts";

// A real browser cell for docker tests, limited to four CPUs as a computer's is, behind a stand-in
// gate that serves its test site. Build the image under its own tag (LOCALDOT_BROWSER_IMAGE) to test
// browserd changes.
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SECCOMP = join(import.meta.dirname, "..", "browser-seccomp.json");
export const CELL_SITE = "http://app.localdot.test";
export const BUSY_BAND: [number, number, number] = [200, 30, 30];
// /slow.bin sends a 64 KiB chunk a second.
export const SLOW_CHUNKS = 24;

// A small canvas redrawn every frame and a timer that keeps the main thread a little busy: about a
// core and a half at scale 2, mostly Chromium compositing the whole window in software, as for the
// video feeds measured. A page that took all four CPUs would leave reads of it no time to answer.
// Below, a red band that never changes and what the page says about itself; it calls home four
// times a second, which only a running page does.
const BUSY = `<!doctype html><title>Busy page</title><style>
body { margin: 0; font: 20px sans-serif; background: #fff; }
canvas { position: absolute; left: 20px; top: 20px; }
#band { position: absolute; left: 0; right: 0; bottom: 0; height: 200px; background: rgb(200,30,30); }
#state { margin: 20px; color: #fff; }
</style><body><canvas id="c"></canvas><div id="band"><pre id="state"></pre></div><script>
const stats = { frames: 0, ticks: 0 };
const c = document.getElementById("c");
c.width = 320 * devicePixelRatio;
c.height = 180 * devicePixelRatio;
c.style.width = "320px";
c.style.height = "180px";
const g = c.getContext("2d");
(function frame(t) {
  stats.frames++;
  for (let i = 0; i < 40; i++) {
    g.fillStyle = "hsl(" + ((t / 5 + i * 7) % 360) + ",80%,50%)";
    g.fillRect((i * 97 + t) % c.width, (i * 53 + t / 2) % c.height, 200, 200);
  }
  requestAnimationFrame(frame);
})(0);
setInterval(() => {
  stats.ticks++;
  const end = performance.now() + 4;
  while (performance.now() < end);
}, 40);
setInterval(() => {
  fetch("/beat?page=" + location.pathname, { cache: "no-store" }).catch(() => {});
}, 250);
setInterval(() => {
  document.getElementById("state").textContent = JSON.stringify({
    ...stats,
    visible: document.visibilityState,
    cookie: document.cookie.includes("session=signed-in"),
  });
}, 250);
</script></body>`;

// Pages that move on by themselves once they commit: /hop sends itself to /landed by script before
// it loads, as web.telegram.org sends itself to /k/; /reload-once reloads itself once, as a
// challenge page does. Both end on the busy page.
const HOP = `<!doctype html><title>Hop</title><script>location.replace("/landed")</script>`;
const RELOAD_ONCE = `<!doctype html><title>Checking</title><script>
if (!sessionStorage.getItem("checked")) { sessionStorage.setItem("checked", "1"); location.reload(); }
else location.replace("/checked");
</script>`;

// A page in Chinese, which a browser set to English offers to translate, and pages that open an
// app's own link as they load, as douyin.com opens its desktop app: the page itself, or a frame in it.
const CHINESE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>中文页面</title>
<body><h1>欢迎来到这个页面</h1><p>${"这是一个用来测试浏览器的中文页面，里面有足够多的中文内容，让浏览器判断它的语言。".repeat(12)}</p>
<button id="go" onclick="this.textContent='已点击'">点击这里</button></body></html>`;
const APP_LINK = `<!doctype html><title>App link</title><body><h1>App link page</h1>
<button id="go" onclick="this.textContent='clicked'">Press here</button>
<script>setTimeout(() => { location.href = "localdot-test-app://open"; }, 300)</script></body>`;
const APP_FRAME = `<!doctype html><title>App frame</title><body><h1>App frame page</h1>
<button id="go" onclick="this.textContent='clicked'">Press here</button>
<script>setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = "localdot-test-app://open";
  document.body.append(frame);
}, 300)</script></body>`;

// A page whose picture asks for a name and password, which the browser asks for in its own dialog.
const NEEDS_SIGN_IN = `<!doctype html><title>Needs sign-in</title><body><h1>Needs sign-in page</h1>
<img src="/locked.png" alt=""></body>`;

const GATE = `
import http.server, json, time, urllib.parse
pages = {"/hop": ${JSON.stringify(HOP)}.encode(), "/reload-once": ${JSON.stringify(RELOAD_ONCE)}.encode(),
         "/zh": ${JSON.stringify(CHINESE)}.encode(), "/app-link": ${JSON.stringify(APP_LINK)}.encode(),
         "/app-frame": ${JSON.stringify(APP_FRAME)}.encode(),
         "/needs-sign-in": ${JSON.stringify(NEEDS_SIGN_IN)}.encode()}
busy = ${JSON.stringify(BUSY)}.encode()
beats = {}
SLOW_CHUNKS = ${SLOW_CHUNKS}
class Gate(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        if path == "/beat":
            which = urllib.parse.parse_qs(url.query).get("page", [""])[0]
            beats[which] = beats.get(which, 0) + 1
            self.send_response(204)
            self.end_headers()
            return
        if path == "/beats":
            body = json.dumps(beats).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/locked.png":
            self.send_response(401)
            self.send_header("www-authenticate", 'Basic realm="localdot test"')
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_response(200)
        if path == "/slow.bin":
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-disposition", 'attachment; filename="slow.bin"')
            self.send_header("content-length", str(SLOW_CHUNKS * 65536))
            self.end_headers()
            for _ in range(SLOW_CHUNKS):
                self.wfile.write(b"x" * 65536)
                self.wfile.flush()
                time.sleep(1)
            return
        if path == "/signin":
            self.send_header("set-cookie", "session=signed-in; path=/; max-age=3600")
        page = pages.get(path, busy)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

export interface BusyStats {
  frames: number;
  ticks: number;
  visible: string;
  cookie: boolean;
  url: string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

export async function bandShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels)
    if (
      Math.abs((data[offset] ?? 0) - BUSY_BAND[0]) < 25 &&
      Math.abs((data[offset + 1] ?? 0) - BUSY_BAND[1]) < 25 &&
      Math.abs((data[offset + 2] ?? 0) - BUSY_BAND[2]) < 25
    )
      count++;
  return count / (info.width * info.height);
}

export interface BrowserCellNames {
  network: string;
  gate: string;
  browser: string;
}

export class TestBrowserCell {
  readonly lifetime = new AbortController();
  readonly owner: BrowserScope = {
    signal: this.lifetime.signal,
    check: () => this.lifetime.signal.throwIfAborted(),
  };
  client!: BrowserClient;
  identity!: { browserCellId: string; parentCellId: string; instance: string };
  serviceUrl = "";
  #serviceToken = "";
  #attached?: ChildProcess;
  #revision = 0;

  private constructor(
    readonly names: BrowserCellNames,
    private readonly subnet: string,
    private readonly label: string,
  ) {}

  static async open(options: {
    names: BrowserCellNames;
    subnet: string;
    label: string;
  }): Promise<TestBrowserCell> {
    const cell = new TestBrowserCell(options.names, options.subnet, options.label);
    cell.remove();
    docker(
      "network",
      "create",
      "--label",
      options.label,
      "--subnet",
      `${options.subnet}.0/24`,
      options.names.network,
    );
    docker(
      "run",
      "-d",
      "--name",
      options.names.gate,
      "--label",
      options.label,
      "--memory",
      "128m",
      "--network",
      options.names.network,
      "--ip",
      `${options.subnet}.2`,
      "--entrypoint",
      "/usr/bin/python3",
      DESKTOP_IMAGE,
      "-c",
      GATE,
    );
    await cell.restart();
    return cell;
  }

  // A browser started anew on the same profile-less cell, as a restart gives: a new instance with
  // one blank window. A cell may not get its window manager up in time on a loaded machine.
  async restart(): Promise<void> {
    this.client?.close();
    this.#attached?.kill();
    for (let attempt = 0; attempt < 12; attempt++) {
      const started = await this.#start();
      if (!started) continue;
      this.identity = started;
      this.#revision = 0;
      this.client = new BrowserClient({
        ...started,
        browserd: { baseUrl: this.serviceUrl, token: this.#serviceToken },
        stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
      });
      return;
    }
    throw new Error("browserd did not become ready");
  }

  async #start() {
    const { names } = this;
    execFileSync("sh", ["-c", `docker rm -fv ${names.browser} >/dev/null 2>&1 || true`]);
    const browserCellId = ulid();
    const parentCellId = ulid();
    this.#serviceToken = token();
    docker(
      "create",
      "-i",
      "--name",
      names.browser,
      "--label",
      this.label,
      "--memory",
      "2g",
      "--cpus",
      "4",
      "--network",
      names.network,
      "--ip",
      `${this.subnet}.3`,
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
      `LOCALDOT_BROWSERD_TOKEN=${this.#serviceToken}`,
      "-e",
      `LOCALDOT_STREAM_TOKEN=${token()}`,
      "-e",
      `LOCALDOT_GATE_ADDR=${this.subnet}.2`,
      "-e",
      "LOCALDOT_SCALE=2",
      "-e",
      "LOCALDOT_STREAM_FULLCOLOR=0",
      IMAGE,
    );
    this.#attached = spawn("docker", ["start", "-a", "-i", names.browser], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    this.#attached.stdin?.end(
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
    if (!port) return undefined;
    this.serviceUrl = `http://127.0.0.1:${port}`;
    let instance = "";
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !instance; ) {
      if (docker("inspect", "-f", "{{.State.Running}}", names.browser) !== "true") break;
      try {
        const res = await fetch(`${this.serviceUrl}/health`, {
          headers: { authorization: `Bearer ${this.#serviceToken}` },
          signal: AbortSignal.timeout(3000),
        });
        const body = (await res.json()) as { ready?: boolean; instance?: string };
        if (res.ok && body.ready && body.instance) instance = body.instance;
      } catch {
        // browserd is still starting
      }
      if (!instance) await sleep(1000);
    }
    return instance ? { browserCellId, parentCellId, instance } : undefined;
  }

  async grant(sessionId: string): Promise<BrowserActionPermit> {
    const request = {
      ...this.identity,
      revision: ++this.#revision,
      requestId: ulid(),
      owner: { sessionId, generation: 1 },
    };
    await this.client.control({ ...request, holder: "agent" }, this.owner);
    return request;
  }

  // The task is over: its window is free for the next one.
  async release(permit: BrowserActionPermit): Promise<void> {
    await this.client.control(
      {
        ...this.identity,
        revision: ++this.#revision,
        requestId: ulid(),
        holder: "release",
        owner: permit.owner,
      },
      this.owner,
    );
  }

  lifecycle(request: { frozen: false } | { frozen: true; keep: readonly string[] }) {
    const full: BrowserLifecycleRequest = request.frozen
      ? { ...this.identity, frozen: true, keep: [...request.keep] }
      : { ...this.identity, frozen: false };
    return this.client.lifecycle(full, this.owner);
  }

  // Reads tolerate a page settling and the accessibility bus catching up after a raise.
  async settled<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= 40 || !(error instanceof BrowserClientError)) throw error;
        await sleep(250);
      }
    }
  }

  // What the busy page says about itself, read as a task reads it.
  stats(permit: BrowserActionPermit, tabId: string): Promise<BusyStats> {
    return this.settled(async () => {
      const page = await this.client.read(permit, tabId, { maxChars: 4000 }, this.owner);
      if (!page.text.includes('"frames"')) throw new BrowserClientError("refused");
      const json = page.text.slice(page.text.indexOf("{"), page.text.lastIndexOf("}") + 1);
      return { ...(JSON.parse(json) as Omit<BusyStats, "url">), url: page.url };
    });
  }

  // The page runs: its frames and timers go on between two reads a second and a half apart.
  async running(permit: BrowserActionPermit, tabId: string) {
    const before = await this.stats(permit, tabId);
    await sleep(1500);
    const after = await this.stats(permit, tabId);
    return {
      url: after.url,
      visible: after.visible,
      cookie: after.cookie,
      frames: after.frames - before.frames,
      ticks: after.ticks - before.ticks,
    };
  }

  // How often each page has called home, counted by the gate: a frozen page's timers don't run.
  beats(): Record<string, number> {
    const read =
      "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3128/beats').read().decode())";
    return JSON.parse(docker("exec", this.names.gate, "python3", "-c", read));
  }

  async beating(ms: number): Promise<(page: string) => number> {
    const before = this.beats();
    await sleep(ms);
    const after = this.beats();
    return (page) => (after[page] ?? 0) - (before[page] ?? 0);
  }

  cpuMicros(): number {
    const stat = docker("exec", this.names.browser, "cat", "/sys/fs/cgroup/cpu.stat");
    return Number(/usage_usec (\d+)/u.exec(stat)?.[1] ?? 0);
  }

  // The whole cell's CPU over a while, one core = 100 %.
  async cpu(ms: number): Promise<number> {
    const before = this.cpuMicros();
    const started = performance.now();
    await sleep(ms);
    return Math.round(((this.cpuMicros() - before) / 1000 / (performance.now() - started)) * 100);
  }

  // How much of the display the busy page's band takes, read without asking browserd anything.
  screen(): Promise<number> {
    const png = execFileSync(
      "docker",
      ["exec", this.names.browser, "sh", "-c", "DISPLAY=:1 import -window root -resize 25% png:-"],
      { maxBuffer: 64 * 1024 ** 2 },
    );
    return bandShare(png);
  }

  async supervisor(): Promise<{ state: string; restarts: number }> {
    const reply = await fetch(`${this.serviceUrl}/supervisor`, {
      headers: { authorization: `Bearer ${this.#serviceToken}` },
    });
    return (await reply.json()) as { state: string; restarts: number };
  }

  logs(): string {
    return execFileSync(
      "sh",
      ["-c", `docker logs ${this.names.browser} 2>&1 | grep browserd: | tail -8`],
      { encoding: "utf8" },
    );
  }

  remove(): void {
    for (const name of [this.names.browser, this.names.gate])
      execFileSync("sh", ["-c", `docker rm -fv ${name} >/dev/null 2>&1 || true`]);
    execFileSync("sh", ["-c", `docker network rm ${this.names.network} >/dev/null 2>&1 || true`]);
  }

  close(): void {
    this.lifetime.abort();
    this.client?.close();
    this.#attached?.kill();
    this.remove();
  }
}
