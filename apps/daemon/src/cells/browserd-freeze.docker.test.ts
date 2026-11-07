import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "../browser/client.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// A real browser cell, limited to four CPUs as a computer's is, showing a page that keeps its
// CPUs busy the way a video feed does: frozen while nobody uses it, woken by whatever comes next.
// Build the image under its own tag (LOCALDOT_BROWSER_IMAGE) to test browserd changes.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.233.58";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const SITE = "http://app.localdot.test";
const BAND: [number, number, number] = [200, 30, 30];
const SAMPLE_MS = 10_000;

// A small canvas redrawn every frame and a timer that keeps the main thread a little busy: about a
// core and a half at scale 2, mostly Chromium compositing the whole window in software, as for the
// video feeds measured. A page that took all four CPUs would leave reads of it no time to answer.
// Below, a red band that never changes, and what the page says about itself in it.
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

const GATE = `
import http.server, json, time, urllib.parse
page = ${JSON.stringify(BUSY)}.encode()
beats = {}
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
        self.send_response(200)
        if path == "/slow.bin":
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-disposition", 'attachment; filename="slow.bin"')
            self.send_header("content-length", str(16 * 65536))
            self.end_headers()
            for _ in range(16):
                self.wfile.write(b"x" * 65536)
                self.wfile.flush()
                time.sleep(0.5)
            return
        if path == "/signin":
            self.send_header("set-cookie", "session=signed-in; path=/; max-age=3600")
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

interface Stats {
  frames: number;
  ticks: number;
  visible: string;
  cookie: boolean;
}

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

async function bandShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels)
    if (
      Math.abs((data[offset] ?? 0) - BAND[0]) < 25 &&
      Math.abs((data[offset + 1] ?? 0) - BAND[1]) < 25 &&
      Math.abs((data[offset + 2] ?? 0) - BAND[2]) < 25
    )
      count++;
  return count / (info.width * info.height);
}

describe.skipIf(!DOCKER_TESTS)("pages nobody uses, frozen in a real browser cell", () => {
  const names = scope && {
    network: `${scope.namePrefix}freeze-net`,
    gate: `${scope.namePrefix}freeze-gate`,
    browser: `${scope.namePrefix}freeze-browser`,
  };
  const lifetime = new AbortController();
  const owner: BrowserScope = {
    signal: lifetime.signal,
    check: () => lifetime.signal.throwIfAborted(),
  };
  let attached: ChildProcess | undefined;
  let client: BrowserClient;
  let identity: { browserCellId: string; parentCellId: string; instance: string };
  let revision = 0;
  let serviceUrl = "";
  let serviceToken = "";
  const sessionA = ulid();
  const sessionB = ulid();
  let permitA: BrowserActionPermit;
  let permitB: BrowserActionPermit;
  let tabA = "";
  let tabB = "";
  const measured: Record<string, number | string> = {};

  const grant = async (sessionId: string): Promise<BrowserActionPermit> => {
    const request = {
      ...identity,
      revision: ++revision,
      requestId: ulid(),
      owner: { sessionId, generation: 1 },
    };
    await client.control({ ...request, holder: "agent" }, owner);
    return request;
  };
  const freeze = (keep: string[] = []) =>
    client.lifecycle({ ...identity, frozen: true, keep }, owner);
  const thaw = () => client.lifecycle({ ...identity, frozen: false }, owner);
  // Reads tolerate a page settling and the accessibility bus catching up after a raise.
  const settled = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= 40 || !(error instanceof BrowserClientError)) throw error;
        await sleep(250);
      }
    }
  };
  const stats = async (permit: BrowserActionPermit, tabId: string): Promise<Stats> =>
    settled(async () => {
      const text = (await client.read(permit, tabId, { maxChars: 4000 }, owner)).text;
      if (!text.includes('"frames"')) throw new BrowserClientError("refused");
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Stats;
    });
  // The page runs: its frames and timers go on between two reads a second apart.
  const running = async (permit: BrowserActionPermit, tabId: string) => {
    const before = await stats(permit, tabId);
    await sleep(1500);
    const after = await stats(permit, tabId);
    return {
      visible: after.visible,
      cookie: after.cookie,
      frames: after.frames - before.frames,
      ticks: after.ticks - before.ticks,
    };
  };
  const cpuMicros = () => {
    if (!names) return 0;
    const stat = docker("exec", names.browser, "cat", "/sys/fs/cgroup/cpu.stat");
    return Number(/usage_usec (\d+)/u.exec(stat)?.[1] ?? 0);
  };
  // How often each page has called home, counted by the gate: a frozen page's timers don't run.
  const beats = (): Record<string, number> => {
    if (!names) return {};
    const read =
      "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3128/beats').read().decode())";
    return JSON.parse(docker("exec", names.gate, "python3", "-c", read));
  };
  const beating = async (ms: number) => {
    const before = beats();
    await sleep(ms);
    const after = beats();
    return (page: string) => (after[page] ?? 0) - (before[page] ?? 0);
  };
  // The whole cell's CPU over a while, one core = 100 %.
  const cpu = async (ms = SAMPLE_MS) => {
    const before = cpuMicros();
    const started = performance.now();
    await sleep(ms);
    return Math.round(((cpuMicros() - before) / 1000 / (performance.now() - started)) * 100);
  };
  // The display as the stream sends it, read without asking browserd anything.
  const screen = async () => {
    if (!names) return 0;
    const png = execFileSync(
      "docker",
      ["exec", names.browser, "sh", "-c", "DISPLAY=:1 import -window root -resize 25% png:-"],
      { maxBuffer: 64 * 1024 ** 2 },
    );
    return bandShare(png);
  };
  const supervisor = async () => {
    const reply = await fetch(`${serviceUrl}/supervisor`, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    return (await reply.json()) as { state: string; restarts: number };
  };
  const removeAll = () => {
    if (!names) return;
    for (const name of [names.browser, names.gate])
      execFileSync("sh", ["-c", `docker rm -fv ${name} >/dev/null 2>&1 || true`]);
    execFileSync("sh", ["-c", `docker network rm ${names.network} >/dev/null 2>&1 || true`]);
  };

  beforeAll(async () => {
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
    const start = async () => {
      execFileSync("sh", ["-c", `docker rm -fv ${names.browser} >/dev/null 2>&1 || true`]);
      const browserCellId = ulid();
      const parentCellId = ulid();
      serviceToken = token();
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
      if (!port) return undefined;
      serviceUrl = `http://127.0.0.1:${port}`;
      let instance = "";
      for (const deadline = Date.now() + 60_000; Date.now() < deadline && !instance; ) {
        if (docker("inspect", "-f", "{{.State.Running}}", names.browser) !== "true") break;
        try {
          const res = await fetch(`${serviceUrl}/health`, {
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
      return instance ? { browserCellId, parentCellId, instance } : undefined;
    };
    let started: Awaited<ReturnType<typeof start>>;
    for (let attempt = 0; attempt < 12 && !started; attempt++) started = await start();
    if (!started) throw new Error("browserd did not become ready");
    identity = started;
    client = new BrowserClient({
      ...identity,
      browserd: { baseUrl: serviceUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    });
  }, 600_000);

  afterAll(() => {
    if (names)
      console.log(
        execFileSync("sh", ["-c", `docker logs ${names.browser} 2>&1 | grep browserd: | tail -8`], {
          encoding: "utf8",
        }),
      );
    lifetime.abort();
    client?.close();
    attached?.kill();
    removeAll();
    console.log("measured", JSON.stringify(measured));
  });

  it("freezes a busy page nobody uses, and the next look thaws it first", async () => {
    permitA = await grant(sessionA);
    tabA = (await client.enterWindow(permitA, { fresh: true }, owner)).tabs[0]?.id ?? "";
    await settled(() => client.clock(permitA, tabA, owner));
    await client.navigate(permitA, tabA, `${SITE}/signin`, owner);
    const busy = await running(permitA, tabA);
    expect(busy.visible).toBe("visible");
    expect(busy.frames).toBeGreaterThan(0);
    await sleep(3000);
    measured.busyCpu = await cpu();
    measured.busyScreenBand = await screen();

    // The task waits, keeping its grant; nobody watches.
    expect((await freeze()).frozen).toBe(1);
    await sleep(2000);
    measured.frozenCpu = await cpu();
    // Chromium hides the page it freezes: its window shows no page, not its last picture.
    measured.frozenScreenBand = await screen();
    expect(measured.frozenCpu).toBeLessThan(Number(measured.busyCpu) / 4);
    expect(measured.frozenScreenBand).toBeLessThan(0.02);

    // The task looks without a turn first: browserd wakes and shows the page before reading it.
    const look = await settled(() => client.observe(permitA, tabA, owner));
    const seen = await bandShare(Buffer.from(look.frame.image, "base64"));
    measured.thawedLookBand = seen;
    expect(seen).toBeGreaterThan(0.1);
    const after = await running(permitA, tabA);
    expect(after).toMatchObject({ visible: "visible", cookie: true });
    expect(after.frames).toBeGreaterThan(10);
    expect(after.ticks).toBeGreaterThan(10);
    measured.thawedCpu = await cpu();
    expect(measured.thawedCpu).toBeGreaterThan(Number(measured.frozenCpu) * 2);
  });

  it("lets a download go on while its page is frozen", async () => {
    const binding: BrowserDownloadBinding = {
      holder: "agent",
      sessionId: sessionA,
      permit: permitA,
    };
    await client.armDownloads(binding, owner);
    const started = await client.navigate(permitA, tabA, `${SITE}/slow.bin`, owner);
    expect(started.download).toBe(true);
    expect((await freeze()).frozen).toBe(1);
    const began = performance.now();
    let offers: Awaited<ReturnType<BrowserClient["downloads"]>> = [];
    for (let i = 0; i < 120 && !offers.length; i++) {
      offers = await client.downloads(binding, owner);
      if (!offers.length) await sleep(250);
    }
    measured.frozenDownloadMs = Math.round(performance.now() - began);
    const offer = offers[0];
    if (!offer) throw new Error("the download did not finish");
    expect(offer.bytes).toBe(16 * 65536);
    for await (const _chunk of client.readDownload(binding, offer, owner)) {
      // read through, as the quarantine does
    }
    await client.acknowledgeDownload(binding, offer, owner);
    // Listing and collecting a download read no page: it stays frozen.
    expect(await cpu(5000)).toBeLessThan(Number(measured.busyCpu) / 4);
  });

  it("shows a frozen page again on its task's turn, and on a thaw for someone looking", async () => {
    await client.enterWindow(permitA, {}, owner);
    measured.turnScreenBand = await screen();
    expect(measured.turnScreenBand).toBeGreaterThan(0.1);
    expect(await running(permitA, tabA)).toMatchObject({ visible: "visible" });

    await freeze();
    await sleep(1000);
    expect(await screen()).toBeLessThan(0.02);
    const thawing = performance.now();
    await thaw();
    measured.thawMs = Math.round(performance.now() - thawing);
    await sleep(500);
    // Nothing read the page: the thaw alone brought the window on screen back.
    measured.thawScreenBand = await screen();
    expect(measured.thawScreenBand).toBeGreaterThan(0.1);
    expect((await running(permitA, tabA)).frames).toBeGreaterThan(10);
  });

  it("freezes the window of a task at rest while another task works in its own", async () => {
    permitB = await grant(sessionB);
    const entered = await client.enterWindow(permitB, { fresh: true }, owner);
    expect(entered.opened).toBe(true);
    tabB = entered.tabs[0]?.id ?? "";
    await settled(() => client.clock(permitB, tabB, owner));
    await client.navigate(permitB, tabB, `${SITE}/app`, owner);
    expect((await running(permitB, tabB)).frames).toBeGreaterThan(10);
    await sleep(3000);
    // A's page keeps running behind B's window, as a covered window does.
    measured.twoBusyCpu = await cpu();

    expect((await freeze([sessionB])).frozen).toBe(1);
    await sleep(2000);
    measured.oneFrozenCpu = await cpu();
    // One busy page can take most of the cell's four CPUs by itself, so the cell's CPU alone can't
    // tell one frozen page from none: what each page does can.
    const calls = await beating(3000);
    measured.frozenPageCalls = calls("/signin");
    measured.workingPageCalls = calls("/app");
    expect(measured.frozenPageCalls).toBe(0);
    expect(measured.workingPageCalls).toBeGreaterThan(5);
    expect(await running(permitB, tabB)).toMatchObject({ visible: "visible" });

    // A's turn brings its window forward, shown and running.
    await client.enterWindow(permitA, {}, owner);
    const a = await running(permitA, tabA);
    expect(a).toMatchObject({ visible: "visible", cookie: true });
    expect(a.frames).toBeGreaterThan(10);
    expect((await supervisor()).restarts).toBe(0);
  });
});
