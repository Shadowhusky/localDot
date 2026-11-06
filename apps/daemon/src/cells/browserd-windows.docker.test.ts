import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "../browser/client.ts";
import {
  BROWSER_WINDOW_LOST,
  ScreenController,
  type ScreenLease,
} from "../browser/screen-controller.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { ScreenRecordings } from "../recorder/screen-recordings.ts";
import type { ReadyBrowser } from "./browser-orchestrator.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// Two tasks in one real browser cell, run as the orchestrator runs one, with a stand-in gate that
// serves one signed-in test site: each task has its own window, they act in turn, and the cookies
// are the profile's. No keyd, no live computer.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.233.57";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const SITE = "http://app.localdot.test";

const PAGE = `<!doctype html><title>Test site</title><style>
body { margin: 0; font: 20px sans-serif; }
#field { position: absolute; left: 100px; top: 100px; width: 400px; height: 40px; }
#show { position: absolute; left: 100px; top: 180px; width: 200px; height: 40px; }
#menu { position: absolute; left: 400px; top: 180px; width: 200px; height: 40px; }
#hover { position: absolute; left: 700px; top: 180px; width: 200px; height: 40px; background: #ddd; }
#pick { position: absolute; left: 100px; top: 260px; width: 200px; height: 40px; }
#state { position: absolute; left: 100px; top: 340px; width: 900px; }
.menu { position: absolute; top: 230px; width: 200px; height: 80px; }
#blurs { left: 400px; background: #ccf; }
#stays { left: 650px; background: #fcc; }
</style><body>
<input id="field" aria-label="Field">
<button id="show">Show state</button>
<button id="menu">Open menus</button>
<div id="hover" role="button" aria-label="Hover me">Hover me</div>
<select id="pick" aria-label="Pick"><option>one</option><option>two</option><option>three</option></select>
<div id="blurs" class="menu" hidden>Closes on blur</div>
<div id="stays" class="menu" hidden>Stays open</div>
<pre id="state"></pre>
<script>
const params = new URLSearchParams(location.search);
document.body.style.background = params.get("color") || "#fff";
const stats = { ticks: 0, frames: 0, hovering: false, entered: 0, left: 0, blurs: 0 };
setInterval(() => { stats.ticks++; }, 100);
(function frame() { stats.frames++; requestAnimationFrame(frame); })();
addEventListener("blur", () => { stats.blurs++; document.getElementById("blurs").hidden = true; });
const hover = document.getElementById("hover");
hover.addEventListener("mouseenter", () => { stats.hovering = true; stats.entered++; });
hover.addEventListener("mouseleave", () => { stats.hovering = false; stats.left++; });
document.getElementById("menu").addEventListener("click", (event) => {
  event.stopPropagation();
  document.getElementById("blurs").hidden = false;
  document.getElementById("stays").hidden = false;
});
document.addEventListener("click", () => { document.getElementById("stays").hidden = true; });
document.getElementById("show").addEventListener("click", (event) => {
  event.stopPropagation();
  document.getElementById("state").textContent = JSON.stringify({
    ...stats,
    cookie: document.cookie.includes("session=signed-in"),
    field: document.getElementById("field").value,
    visible: document.visibilityState,
    blursOpen: !document.getElementById("blurs").hidden,
    staysOpen: !document.getElementById("stays").hidden,
    pick: document.getElementById("pick").value,
  });
});
</script></body>`;

const GATE = `
import http.server, time, urllib.parse
page = ${JSON.stringify(PAGE)}.encode()
class Gate(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/slow":
            time.sleep(int(query.get("ms", ["8000"])[0]) / 1000)
        self.send_response(200)
        if url.path == "/signin":
            self.send_header("set-cookie", "session=signed-in; path=/; max-age=3600")
        if url.path == "/signout":
            self.send_header("set-cookie", "session=; path=/; max-age=0")
        if url.path == "/file.bin":
            content = b"downloaded by a task"
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-disposition", 'attachment; filename="task.bin"')
        else:
            content = page
            self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

const RED = "rgb(200,30,30)";
const BLUE = "rgb(30,30,200)";
const page = (color: string, path = "/app") => `${SITE}${path}?color=${encodeURIComponent(color)}`;

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

interface Stats {
  ticks: number;
  frames: number;
  hovering: boolean;
  entered: number;
  left: number;
  blurs: number;
  cookie: boolean;
  field: string;
  visible: string;
  blursOpen: boolean;
  staysOpen: boolean;
  pick: string;
}

describe.skipIf(!DOCKER_TESTS)("two tasks in their own windows of one browser", () => {
  const names = scope && {
    network: `${scope.namePrefix}windows-net`,
    gate: `${scope.namePrefix}windows-gate`,
    browser: `${scope.namePrefix}windows-browser`,
  };
  const lifetime = new AbortController();
  const lifetimeScope: BrowserScope = {
    signal: lifetime.signal,
    check: () => lifetime.signal.throwIfAborted(),
  };
  const owner = lifetimeScope;
  let attached: ChildProcess | undefined;
  let client: BrowserClient;
  let identity: { browserCellId: string; parentCellId: string; instance: string };
  let revision = 0;
  const sessionA = ulid();
  const sessionB = ulid();
  let permitA: BrowserActionPermit;
  let permitB: BrowserActionPermit;
  let tabA = "";
  let tabB = "";
  let serviceUrl = "";
  let serviceToken = "";
  let streamUrl = "";
  let streamToken = "";
  const measured: Record<string, number> = {};

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
  const toUser = async (front?: string) => {
    const request = { ...identity, revision: ++revision, requestId: ulid() };
    await client.control({ ...request, holder: "user", ...(front ? { front } : {}) }, owner);
    return request;
  };
  const release = async (permit: BrowserActionPermit, keep = false) => {
    await client.control(
      {
        ...identity,
        revision: ++revision,
        requestId: ulid(),
        holder: "release",
        owner: permit.owner,
        ...(keep ? { keep: true as const } : {}),
      },
      owner,
    );
  };
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
  const inFront = async (permit: BrowserActionPermit, tabId: string) => {
    await client.enterWindow(permit, {}, owner);
    return settled(async () => {
      await client.clock(permit, tabId, owner);
      return client.read(permit, tabId, { maxChars: 2000 }, owner);
    });
  };
  const element = async (permit: BrowserActionPermit, tabId: string, name: string) => {
    const { targets } = await settled(() => client.observe(permit, tabId, owner));
    const found = targets.find((target) => target.name === name);
    if (!found) throw new Error(`${name} is missing`);
    return found;
  };
  const click = async (permit: BrowserActionPermit, tabId: string, name: string) => {
    const target = await element(permit, tabId, name);
    await settled(() =>
      client.input(
        permit,
        tabId,
        {
          input: { kind: "click", at: target.point, button: "left", count: 1 },
          injector: "xtest",
          holdMs: 0,
        },
        owner,
      ),
    );
  };
  const type = (permit: BrowserActionPermit, tabId: string, text: string) =>
    settled(() =>
      client.type(
        permit,
        tabId,
        {
          text,
          masked: false,
          injector: "xtest",
          pace: { firstCount: 0, firstMs: 0, restMs: 0 },
        },
        owner,
        () => {},
      ),
    );
  // What the page says about itself, on the task's own turn.
  const stats = async (permit: BrowserActionPermit, tabId: string): Promise<Stats> => {
    await inFront(permit, tabId);
    await click(permit, tabId, "Show state");
    const reading = await settled(async () => {
      const text = (await client.read(permit, tabId, { maxChars: 4000 }, owner)).text;
      if (!text.includes('"ticks"')) throw new BrowserClientError("refused");
      return text;
    });
    const json = reading.slice(reading.indexOf("{"), reading.lastIndexOf("}") + 1);
    return JSON.parse(json) as Stats;
  };
  const colourShare = async (image: string, colour: [number, number, number]) => {
    const { data, info } = await sharp(Buffer.from(image, "base64"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let offset = 0; offset < data.length; offset += info.channels)
      if (
        Math.abs((data[offset] ?? 0) - colour[0]) < 25 &&
        Math.abs((data[offset + 1] ?? 0) - colour[1]) < 25 &&
        Math.abs((data[offset + 2] ?? 0) - colour[2]) < 25
      )
        count++;
    return count / (info.width * info.height);
  };
  // A task's page is red or blue below the browser's own bar.
  const colourAt = async (file: string): Promise<"red" | "blue" | "other"> => {
    const { data, info } = await sharp(file)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (info.width * Math.floor(info.height * 0.85) + Math.floor(info.width * 0.9)) * 3;
    const [r = 0, g = 0, b = 0] = [data[at], data[at + 1], data[at + 2]];
    if (r > 140 && g < 90 && b < 90) return "red";
    if (b > 140 && g < 90 && r < 90) return "blue";
    return "other";
  };
  const supervisor = async () => {
    const reply = await fetch(`${serviceUrl}/supervisor`, {
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    return (await reply.json()) as {
      state: string;
      restarts: number;
      lastFailure?: { detail: string };
    };
  };
  const removeAll = () => {
    if (!names) return;
    for (const name of [names.browser, names.gate])
      execFileSync("sh", ["-c", `docker rm -fv ${name} >/dev/null 2>&1 || true`]);
    execFileSync("sh", ["-c", `docker network rm ${names.network} >/dev/null 2>&1 || true`]);
  };
  const memory = () => {
    if (!names) return 0;
    return Number(docker("exec", names.browser, "cat", "/sys/fs/cgroup/memory.current"));
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
      streamToken = token();
      docker(
        "create",
        "-i",
        "--name",
        names.browser,
        "--label",
        scope.label,
        "--memory",
        "1400m",
        "--network",
        names.network,
        "--ip",
        `${SUBNET}.3`,
        "-p",
        "127.0.0.1::7700",
        "-p",
        "127.0.0.1::3000",
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
        String(256 * 1024 ** 2),
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
        `LOCALDOT_STREAM_TOKEN=${streamToken}`,
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
      streamUrl = `http://127.0.0.1:${publishedPort(names.browser, "3000")}`;
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
    // A cell may not get its window manager up in time on a machine under load.
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
    if (Object.keys(measured).length) console.log("measured", JSON.stringify(measured));
  });

  it("gives the first task the window that is there, the second a window of its own", async () => {
    permitA = await grant(sessionA);
    const first = await client.enterWindow(permitA, { fresh: true }, owner);
    expect(first.opened).toBe(false);
    expect(first.tabs).toHaveLength(1);
    tabA = first.tabs[0]?.id ?? "";
    await settled(() => client.clock(permitA, tabA, owner));
    await client.navigate(permitA, tabA, page(RED), owner);
    await inFront(permitA, tabA);
    await sleep(1500);
    measured.oneWindowBytes = memory();

    permitB = await grant(sessionB);
    const second = await client.enterWindow(permitB, { fresh: true }, owner);
    expect(second.opened).toBe(true);
    expect(second.tabs).toHaveLength(1);
    tabB = second.tabs[0]?.id ?? "";
    expect(tabB).not.toBe(tabA);
    await settled(() => client.clock(permitB, tabB, owner));
    await sleep(1500);
    measured.twoWindowsBlankBytes = memory();
    await client.navigate(permitB, tabB, page(BLUE), owner);
    await inFront(permitB, tabB);
    await sleep(1500);
    measured.twoWindowsPageBytes = memory();
    measured.extraBlankWindowMiB = Math.round(
      (measured.twoWindowsBlankBytes - measured.oneWindowBytes) / 1024 ** 2,
    );
    measured.extraPageWindowMiB = Math.round(
      (measured.twoWindowsPageBytes - measured.oneWindowBytes) / 1024 ** 2,
    );
  });

  it("lets each task see its own window only, on the same address", async () => {
    // The same address in both windows: the active window must still tell them apart.
    await client.navigate(permitA, tabA, page(RED), owner);
    await client.navigate(permitB, tabB, page(BLUE), owner);
    const seenA = await inFront(permitA, tabA);
    expect(seenA.url).toBe(`${SITE}/app`);
    const imageA = await settled(() => client.observe(permitA, tabA, owner));
    expect(await colourShare(imageA.frame.image, [200, 30, 30])).toBeGreaterThan(0.5);
    expect(await colourShare(imageA.frame.image, [30, 30, 200])).toBeLessThan(0.01);

    const seenB = await inFront(permitB, tabB);
    expect(seenB.url).toBe(`${SITE}/app`);
    const imageB = await settled(() => client.observe(permitB, tabB, owner));
    expect(await colourShare(imageB.frame.image, [30, 30, 200])).toBeGreaterThan(0.5);
    expect(await colourShare(imageB.frame.image, [200, 30, 30])).toBeLessThan(0.01);

    // A permit stops at its window, front or not.
    expect((await client.ownTabs(permitB, owner)).tabs.map((tab) => tab.id)).toEqual([tabB]);
    for (const attempt of [
      () => client.clock(permitA, tabB, owner),
      () => client.observe(permitA, tabB, owner),
      () => client.read(permitA, tabB, { maxChars: 500 }, owner),
      () => client.navigate(permitA, tabB, page(RED), owner),
      () =>
        client.input(
          permitA,
          tabB,
          {
            input: { kind: "click", at: { x: 10, y: 200 }, button: "left", count: 1 },
            injector: "xtest",
            holdMs: 0,
          },
          owner,
        ),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: "refused" });
    // The active window is B's: A's own tab is not in front, so A may not act either.
    await expect(client.clock(permitA, tabA, owner)).rejects.toMatchObject({ code: "refused" });
  });

  it("takes alternate turns that land in each task's own window", async () => {
    await inFront(permitA, tabA);
    await click(permitA, tabA, "Field");
    await inFront(permitB, tabB);
    await click(permitB, tabB, "Field");
    const started = performance.now();
    for (let round = 0; round < 4; round++) {
      await inFront(permitA, tabA);
      await type(permitA, tabA, "a");
      await inFront(permitB, tabB);
      await type(permitB, tabB, "b");
    }
    measured.alternatingRoundMs = Math.round((performance.now() - started) / 4);
    expect((await stats(permitA, tabA)).field).toBe("aaaa");
    expect((await stats(permitB, tabB)).field).toBe("bbbb");
  });

  it("shares sign-ins: signing in and out in one task is both tasks'", async () => {
    await client.navigate(permitA, tabA, `${SITE}/signin?color=${encodeURIComponent(RED)}`, owner);
    await client.navigate(permitB, tabB, page(BLUE), owner);
    expect((await stats(permitB, tabB)).cookie).toBe(true);
    await client.navigate(
      permitB,
      tabB,
      `${SITE}/signout?color=${encodeURIComponent(BLUE)}`,
      owner,
    );
    await client.navigate(permitA, tabA, page(RED), owner);
    expect((await stats(permitA, tabA)).cookie).toBe(false);
  });

  it("keeps a covered window working as if it were in front", async () => {
    await inFront(permitB, tabB);
    const before = await stats(permitA, tabA);
    await inFront(permitB, tabB);
    await sleep(5000);
    const after = await stats(permitA, tabA);
    measured.coveredTicksIn5s = after.ticks - before.ticks;
    measured.coveredFramesIn5s = after.frames - before.frames;
    expect(after.visible).toBe("visible");
    expect(after.ticks - before.ticks).toBeGreaterThan(30);
    expect(after.frames - before.frames).toBeGreaterThan(30);
  });

  it("does not hold the lane while a page loads, or restart anything for a slow one", async () => {
    await inFront(permitA, tabA);
    const started = performance.now();
    const slow = client.navigate(permitA, tabA, `${SITE}/slow?ms=9000&color=red`, owner);
    await sleep(500);
    await inFront(permitB, tabB);
    await click(permitB, tabB, "Show state");
    const during = performance.now() - started;
    expect(during).toBeLessThan(8000);
    await slow;
    measured.slowLoadMs = Math.round(performance.now() - started);
    expect(measured.slowLoadMs).toBeGreaterThan(8500);
    await inFront(permitA, tabA);
    expect((await supervisor()).restarts).toBe(0);
  });

  it("reports what survives another task's turn", async () => {
    await client.navigate(permitA, tabA, page(RED), owner);
    await inFront(permitA, tabA);
    await click(permitA, tabA, "Open menus");
    await inFront(permitB, tabB);
    await click(permitB, tabB, "Show state");
    const menus = await stats(permitA, tabA);
    // A menu that closes when its window loses focus closes; one that waits for a click stays.
    expect(menus.blursOpen).toBe(false);

    // A hover keeps: the pointer comes back to where the task left it.
    const hover = await element(permitA, tabA, "Hover me");
    await client.input(
      permitA,
      tabA,
      { input: { kind: "move", to: hover.point }, injector: "xtest", holdMs: 0 },
      owner,
    );
    await sleep(200);
    await inFront(permitB, tabB);
    const elsewhere = await element(permitB, tabB, "Show state");
    await client.input(
      permitB,
      tabB,
      { input: { kind: "move", to: elsewhere.point }, injector: "xtest", holdMs: 0 },
      owner,
    );
    await inFront(permitA, tabA);
    const pointer = await settled(() => client.observe(permitA, tabA, owner));
    expect(pointer.frame.pointer.x).toBeCloseTo(hover.point.x, -1);
    expect(pointer.frame.pointer.y).toBeCloseTo(hover.point.y, -1);

    // Keyboard focus comes back to the field the task left it in.
    await click(permitA, tabA, "Field");
    await inFront(permitB, tabB);
    await inFront(permitA, tabA);
    await type(permitA, tabA, "kept");
    expect((await stats(permitA, tabA)).field).toBe("kept");
  });

  it("doesn't let copied text cross from one task to the other", async () => {
    await inFront(permitA, tabA);
    await click(permitA, tabA, "Field");
    await settled(() =>
      client.input(
        permitA,
        tabA,
        { input: { kind: "key", combo: ["ctrl", "a"] }, injector: "xtest", holdMs: 0 },
        owner,
      ),
    );
    await settled(() =>
      client.input(
        permitA,
        tabA,
        { input: { kind: "key", combo: ["ctrl", "c"] }, injector: "xtest", holdMs: 0 },
        owner,
      ),
    );
    await client.navigate(permitB, tabB, page(BLUE), owner);
    await inFront(permitB, tabB);
    await click(permitB, tabB, "Field");
    await settled(() =>
      client.input(
        permitB,
        tabB,
        { input: { kind: "key", combo: ["ctrl", "v"] }, injector: "xtest", holdMs: 0 },
        owner,
      ),
    );
    expect((await stats(permitB, tabB)).field).toBe("");
  });

  it("sends each task its own downloads", async () => {
    const bindingA: BrowserDownloadBinding = {
      holder: "agent",
      sessionId: sessionA,
      permit: permitA,
    };
    const bindingB: BrowserDownloadBinding = {
      holder: "agent",
      sessionId: sessionB,
      permit: permitB,
    };
    await client.armDownloads(bindingA, owner);
    await client.armDownloads(bindingB, owner);
    const started = await client.navigate(permitB, tabB, `${SITE}/file.bin`, owner);
    expect(started.download).toBe(true);
    let offers: Awaited<ReturnType<BrowserClient["downloads"]>> = [];
    for (let i = 0; i < 40 && !offers.length; i++) {
      offers = await client.downloads(bindingB, owner);
      if (!offers.length) await sleep(250);
    }
    expect(offers[0]?.origin.sessionId).toBe(sessionB);
    expect(await client.downloads(bindingA, owner)).toEqual([]);
    const offer = offers[0];
    if (!offer) throw new Error("no download");
    const stream = client.readDownload(bindingB, offer, owner);
    for await (const _chunk of stream) {
      // read through, as the quarantine does
    }
    await client.acknowledgeDownload(bindingB, offer, owner);
  });

  it("takes every grant for the user's control, and shows them their task's window", async () => {
    await inFront(permitB, tabB);
    const manual = await toUser(sessionA);
    await expect(client.clock(permitA, tabA, owner)).rejects.toMatchObject({ code: "refused" });
    await expect(client.clock(permitB, tabB, owner)).rejects.toMatchObject({ code: "refused" });
    await client.manual(manual, { kind: "key", combo: ["Escape"] }, owner);
    // Handing back: the user's task first, then the other takes its grant on its next turn.
    permitA = await grant(sessionA);
    await inFront(permitA, tabA);
    await expect(client.clock(permitB, tabB, owner)).rejects.toMatchObject({ code: "refused" });
    permitB = await grant(sessionB);
    const entered = await client.enterWindow(permitB, {}, owner);
    expect(entered.opened).toBe(false);
    await settled(() => client.clock(permitB, tabB, owner));
    expect(entered.tabs.map((tab) => tab.id)).toEqual([tabB]);
    expect((await supervisor()).restarts).toBe(0);
  });

  it("records each task its own window, and nothing of the other's", async () => {
    const home = mkdtempSync(join(tmpdir(), "localdot-parallel-recording-"));
    const clock = {
      nowMicros: () => Math.round((performance.timeOrigin + performance.now()) * 1000),
    };
    const log = new EventLog(home, clock);
    const a = log.createSession("a");
    const b = log.createSession("b");
    const stream = {
      baseUrl: streamUrl,
      authorization: `Basic ${Buffer.from(`localdot:${streamToken}`).toString("base64")}`,
    };
    const cells = {
      get: () => undefined,
      endpoints: () => ({ stream }) as never,
    };
    const recordings = new ScreenRecordings(
      { home, clock, eventLog: log, cells, freeBytes: () => 1024 ** 4, startTimeoutMs: 15_000 },
      { cells },
    );
    const both = [a, b];
    const selection = {
      screen: "browser" as const,
      cellId: identity.browserCellId,
      geometry: { w: 2560, h: 1600, scale: 2 as const },
      revision: 1,
    };
    const turn = async (id: string, permit: BrowserActionPermit, tab: string) => {
      recordings.coming(identity.browserCellId, id, "browser", both);
      await client.enterWindow(permit, {}, owner);
      recordings.up(id, "browser");
      await settled(() => client.clock(permit, tab, owner));
    };
    try {
      await client.navigate(permitA, tabA, page(RED), owner);
      await client.navigate(permitB, tabB, page(BLUE), owner);
      await turn(a, permitA, tabA);
      await recordings.attach(a, selection, owner);
      await turn(b, permitB, tabB);
      await recordings.attach(b, selection, owner);
      const started = performance.now();
      let rounds = 0;
      while (performance.now() - started < 30_000) {
        for (const [id, permit, tab] of [
          [a, permitA, tabA],
          [b, permitB, tabB],
        ] as const) {
          await turn(id, permit, tab);
          await sleep(1200);
          await click(permit, tab, "Show state");
          await sleep(800);
        }
        rounds++;
      }
      measured.recordedRounds = rounds;
      await recordings.stopAll(20_000);
      const shares = (id: string) => {
        const dir = mkdtempSync(join(home, "frames-"));
        execFileSync("ffmpeg", [
          "-loglevel",
          "fatal",
          "-i",
          join(home, "sessions", id, "recording-browser", "video.mp4"),
          "-fps_mode",
          "passthrough",
          "-vf",
          "scale=64:40",
          join(dir, "%05d.png"),
        ]);
        return Promise.all(readdirSync(dir).map((file) => colourAt(join(dir, file))));
      };
      const framesA = await shares(a);
      const framesB = await shares(b);
      measured.framesRecordedA = framesA.length;
      measured.framesRecordedB = framesB.length;
      measured.blueFramesInA = framesA.filter((colour) => colour === "blue").length;
      measured.redFramesInB = framesB.filter((colour) => colour === "red").length;
      expect(framesA.filter((colour) => colour === "red").length).toBeGreaterThan(0);
      expect(framesB.filter((colour) => colour === "blue").length).toBeGreaterThan(0);
      expect(measured.blueFramesInA).toBe(0);
      expect(measured.redFramesInB).toBe(0);
      const gaps = recordings.info(a, "browser")?.manifest.gaps ?? [];
      expect(gaps.some((gap) => gap.reason === "other-task")).toBe(true);
    } finally {
      await recordings.stopAll(5000);
      log.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it("ends one task without touching the other", async () => {
    // Stopped in the middle of a load: only that task's tab goes, and nothing restarts.
    await inFront(permitA, tabA);
    const abort = new AbortController();
    const stopping = client
      .navigate(permitA, tabA, `${SITE}/slow?ms=6000`, {
        signal: abort.signal,
        check: () => abort.signal.throwIfAborted(),
      })
      .catch((error: unknown) => error);
    await sleep(800);
    abort.abort();
    await stopping;
    await release(permitA);
    await sleep(500);
    expect((await supervisor()).restarts).toBe(0);
    expect((await supervisor()).state).toBe("running");
    await inFront(permitB, tabB);
    await click(permitB, tabB, "Field");
    await type(permitB, tabB, "still working");
    expect((await stats(permitB, tabB)).field).toContain("still working");
    await expect(client.clock(permitA, tabA, owner)).rejects.toBeDefined();
  });

  it("loses nothing but its own request when a task is stopped in the middle of one", async () => {
    await inFront(permitB, tabB);
    const before = (await supervisor()).restarts;
    const target = await element(permitB, tabB, "Field");
    // Stop lands anywhere: in a screenshot, in a read of the display, around an input.
    for (const [delay, request] of [
      [5, (scope: BrowserScope) => client.observe(permitB, tabB, scope)],
      [40, (scope: BrowserScope) => client.observe(permitB, tabB, scope)],
      [150, (scope: BrowserScope) => client.observe(permitB, tabB, scope)],
      [300, (scope: BrowserScope) => client.observe(permitB, tabB, scope)],
      [20, (scope: BrowserScope) => client.clock(permitB, tabB, scope)],
      [80, (scope: BrowserScope) => client.clock(permitB, tabB, scope)],
      [200, (scope: BrowserScope) => client.read(permitB, tabB, { maxChars: 500 }, scope)],
      [
        60,
        (scope: BrowserScope) =>
          client.input(
            permitB,
            tabB,
            {
              input: { kind: "click", at: target.point, button: "left", count: 1 },
              injector: "xtest",
              holdMs: 0,
            },
            scope,
          ),
      ],
    ] as const) {
      const abort = new AbortController();
      const stopping = request({
        signal: abort.signal,
        check: () => abort.signal.throwIfAborted(),
      }).catch(() => undefined);
      await sleep(delay);
      abort.abort();
      await stopping;
      await settled(() => client.clock(permitB, tabB, owner));
    }
    const state = await supervisor();
    expect(state.state).toBe("running");
    expect(state.restarts).toBe(before);
  }, 120_000);

  it("hands a finished task's window to the next task, blank tab in front", async () => {
    const sessionC = ulid();
    const permitC = await grant(sessionC);
    const before = (await client.tabs(owner)).tabs.length;
    const entered = await client.enterWindow(permitC, { fresh: true }, owner);
    const tabs = (await client.ownTabs(permitC, owner)).tabs.map((tab) => tab.id);
    expect(tabs).not.toContain(tabB);
    expect(tabs.length).toBeGreaterThan(0);
    const blank = await client.openTab(permitC, owner);
    expect(tabs.includes(blank) || entered.opened).toBe(true);
    const seen = await settled(async () => {
      await client.clock(permitC, blank, owner);
      return client.read(permitC, blank, { maxChars: 500 }, owner);
    });
    expect(seen.url).toBe("about:blank");
    expect((await client.tabs(owner)).tabs.length).toBeGreaterThanOrEqual(before);
    // B's window is untouched by it.
    await inFront(permitB, tabB);
    expect((await stats(permitB, tabB)).field).toContain("still working");
    await release(permitC);
  });

  it("runs two tasks through the daemon's screen owners, and Stop on one leaves the other", async () => {
    const parent = identity.parentCellId;
    const endpoint: ReadyBrowser = {
      ...identity,
      browserd: { baseUrl: serviceUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    };
    const live = new LiveSessions();
    const reminded = new Map<string, string[]>();
    const task = (sessionId: string) => {
      const turnOf = (signal: AbortSignal) => live.lease(parent).acquire(sessionId, { signal });
      const words: string[] = [];
      reminded.set(sessionId, words);
      const abort = new AbortController();
      const scope = {
        sessionId,
        generation: 1,
        signal: abort.signal,
        check: () => abort.signal.throwIfAborted(),
      };
      const controller = new ScreenController({
        sessionId,
        parentCellId: parent,
        freshTab: true,
        desktopGeometry: { w: 2560, h: 1600, scale: 2 },
        desktopReady: () => true,
        browser: {
          start: async () => endpoint,
          endpoints: () => endpoint,
          get: () => undefined,
          stop: async () => {
            throw new Error("nothing may stop the browser here");
          },
        },
        revision: () => ++revision,
        attachRecording: async () => {},
        fenceRecording: async () => {},
        publish: () => {},
        fenceSession: () => {
          throw new Error("no containment");
        },
        contain: async () => {
          throw new Error("no containment");
        },
        turn: turnOf,
        remind: (text) => words.push(text),
      });
      const act = async <T>(
        work: (
          access: ReturnType<ScreenController["browserAccess"]>,
          lease: ScreenLease,
        ) => Promise<T>,
      ): Promise<T> => {
        const grant = await turnOf(abort.signal);
        try {
          await controller.enterTurn(scope);
          return await settled(async () => {
            const lease = controller.lease(scope);
            try {
              await controller.refreshBrowser(lease);
              return await work(controller.browserAccess(lease), lease);
            } finally {
              lease.finish();
            }
          });
        } finally {
          grant.release();
        }
      };
      live.start(parent, sessionId, (signal) => once(signal, "abort"));
      return { controller, scope, act, sessionId };
    };
    const c = task(ulid());
    const d = task(ulid());
    await c.controller.switchTo("browser", c.scope);
    await d.controller.switchTo("browser", d.scope);
    await c.act(({ client: own, permit, tabId }, lease) =>
      own.navigate(permit, tabId, page(RED), lease),
    );
    await d.act(({ client: own, permit, tabId }, lease) =>
      own.navigate(permit, tabId, page(BLUE), lease),
    );
    const look = (
      { client: own, permit, tabId }: ReturnType<ScreenController["browserAccess"]>,
      lease: ScreenLease,
    ) => own.observe(permit, tabId, lease);
    for (let round = 0; round < 3; round++) {
      const red = await c.act(look);
      expect(await colourShare(red.frame.image, [200, 30, 30])).toBeGreaterThan(0.5);
      const blue = await d.act(look);
      expect(await colourShare(blue.frame.image, [30, 30, 200])).toBeGreaterThan(0.5);
    }
    const restarts = (await supervisor()).restarts;
    // Stop on one: its grant and window go, and the other goes on in its own.
    live.stop(c.sessionId);
    await c.controller.cancel();
    await live.settled(c.sessionId);
    expect(() => c.controller.lease(c.scope)).toThrow();
    const blue = await d.act(look);
    expect(await colourShare(blue.frame.image, [30, 30, 200])).toBeGreaterThan(0.5);
    expect((await supervisor()).restarts).toBe(restarts);
    expect(reminded.get(d.sessionId)).toEqual([]);
    // A browser that fails under a task is waited out, and the task hears its page went.
    if (names)
      docker("exec", names.browser, "sh", "-c", "pkill -f /usr/lib/chromium/[c]hromium || true");
    await sleep(1000);
    const back = await d.act(look);
    expect(back.frame.image.length).toBeGreaterThan(1000);
    expect(reminded.get(d.sessionId)).toEqual([BROWSER_WINDOW_LOST]);
    await d.controller.takeOver(false);
    live.stop(d.sessionId);
    await d.controller.cancel();
    await live.settled(d.sessionId);
    expect((await client.health(lifetimeScope)).ready).toBe(true);
  }, 180_000);

  it("keeps a grant through a restart in place, on a blank window", async () => {
    if (!names) return;
    await settled(() => client.enterWindow(permitB, {}, owner));
    const before = (await supervisor()).restarts;
    docker("exec", names.browser, "sh", "-c", "pkill -f /usr/lib/chromium/[c]hromium || true");
    let reply: Awaited<ReturnType<BrowserClient["enterWindow"]>> | undefined;
    await sleep(1000);
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !reply; ) {
      try {
        reply = await client.enterWindow(permitB, {}, owner);
      } catch (error) {
        if (!(error instanceof BrowserClientError)) throw error;
        await sleep(500);
      }
    }
    expect((await supervisor()).restarts).toBe(before + 1);
    const tab = reply?.tabs[0]?.id ?? "";
    expect(tab).not.toBe(tabB);
    const seen = await settled(async () => {
      await client.clock(permitB, tab, owner);
      return client.read(permitB, tab, { maxChars: 500 }, owner);
    });
    expect(seen.url).toBe("about:blank");
    tabB = tab;
    expect((await client.health(owner)).ready).toBe(true);
  }, 120_000);

  it("relaunches for sign-in with the others waiting, and only the user's window comes back", async () => {
    await client.navigate(permitB, tabB, page(BLUE), owner);
    await inFront(permitB, tabB);
    const sessionE = ulid();
    const permitE = await grant(sessionE);
    const opened = await client.enterWindow(permitE, {}, owner);
    expect(opened.opened).toBe(true);
    const tabE = opened.tabs[0]?.id ?? "";
    await settled(() => client.clock(permitE, tabE, owner));
    await client.navigate(permitE, tabE, page(RED), owner);
    await inFront(permitE, tabE);
    const manual = await toUser(sessionE);
    expect(await client.signIn(manual, "signin", owner)).toEqual({
      mode: "signin",
      changing: false,
    });
    // Nothing of a task's reaches a browser that is not under control.
    await expect(client.clock(permitB, tabB, owner)).rejects.toMatchObject({ code: "refused" });
    await expect(client.enterWindow(permitB, {}, owner)).rejects.toMatchObject({ code: "refused" });
    expect(await client.signIn(manual, "standard", owner)).toEqual({
      mode: "standard",
      changing: false,
    });
    expect((await client.tabs(owner)).tabs).toHaveLength(1);
    const again = await grant(sessionE);
    const back = await client.enterWindow(again, {}, owner);
    expect(back.opened).toBe(false);
    const restored = back.tabs[0]?.id ?? "";
    const seen = await settled(async () => {
      await client.clock(again, restored, owner);
      return client.read(again, restored, { maxChars: 500 }, owner);
    });
    expect(seen.url).toBe(`${SITE}/app`);
    permitB = await grant(sessionB);
    const other = await client.enterWindow(permitB, {}, owner);
    expect(other.opened).toBe(true);
    expect(other.tabs.map((tab) => tab.id)).not.toContain(restored);
  }, 120_000);
});
