import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Point, ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "../browser/client.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// A browser cell run as the orchestrator runs one (user, read-only root, no capabilities, its
// seccomp profile and tmpfs), on a network of this suite's own with a stand-in gate: a proxy that
// answers every page with the drag page. No keyd, no live computer.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.231.77";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");

const PAGE = `<!doctype html><html><head><title>loading</title><style>
body { margin: 0; font: 20px sans-serif; }
#volume { position: absolute; left: 100px; top: 100px; width: 600px; height: 40px; margin: 0; }
ul { position: absolute; left: 100px; top: 250px; width: 300px; list-style: none; margin: 0; padding: 0; }
li { height: 60px; line-height: 60px; margin: 0 0 10px; padding-left: 16px; background: #ddd; }
</style></head><body>
<input id="volume" aria-label="Volume" type="range" min="0" max="100" value="0">
<ul id="list"><li draggable="true">Alpha</li><li draggable="true">Beta</li><li draggable="true">Gamma</li></ul>
<script>
const volume = document.getElementById("volume");
const list = document.getElementById("list");
const show = () => {
  document.title = "range " + volume.value + " order " + [...list.children].map((li) => li.textContent[0]).join("");
};
let dragged;
list.addEventListener("dragstart", (e) => { dragged = e.target; e.dataTransfer.setData("text/plain", ""); });
list.addEventListener("dragover", (e) => e.preventDefault());
list.addEventListener("drop", (e) => {
  e.preventDefault();
  const onto = e.target.closest("li");
  if (onto && dragged && onto !== dragged) list.insertBefore(dragged, onto.nextSibling);
  show();
});
volume.addEventListener("input", show);
show();
</script></body></html>`;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => randomBytes(32).toString("base64url");

function caCertificate(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-browser-ca-"));
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
}

describe.skipIf(!DOCKER_TESTS)("browserd drags in a real browser cell", () => {
  const names = scope && {
    network: `${scope.namePrefix}browsernet`,
    gate: `${scope.namePrefix}gate`,
    browser: `${scope.namePrefix}browser`,
  };
  let attached: ChildProcess | undefined;
  let client: BrowserClient;
  let permit: Parameters<BrowserClient["input"]>[0];
  let tabId = "";
  const lifetime = new AbortController();
  const owner = (signal = lifetime.signal): BrowserScope => ({
    signal,
    check: () => signal.throwIfAborted(),
  });
  const title = async () => (await client.read(permit, tabId, { maxChars: 500 }, owner())).title;
  const removeAll = () => {
    if (!scope || !names) return;
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
    // The orchestrator's credential handoff: stdin carries the proxy token and the gate's CA once.
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
    const port = await (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          return publishedPort(names.browser, "7700");
        } catch {
          await sleep(500);
        }
      }
      throw new Error("browserd is not published");
    })();
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
    client = new BrowserClient({
      browserCellId,
      parentCellId,
      instance,
      browserd: { baseUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    });
    const control = {
      browserCellId,
      parentCellId,
      instance,
      revision: 1,
      requestId: ulid(),
      owner: { sessionId: ulid(), generation: 1 },
    };
    await client.control({ ...control, holder: "agent" }, owner());
    permit = control;
    for (let i = 0; i < 40 && !tabId; i++) {
      tabId = (await client.tabs(owner())).tabs.find((tab) => tab.ready)?.id ?? "";
      if (!tabId) await sleep(250);
    }
    await client.navigate(permit, tabId, "http://drag.localdot.test/", owner());
    for (let i = 0; i < 40 && !/^range/.test(await title()); i++) await sleep(250);
  }, 240_000);

  afterAll(() => {
    lifetime.abort();
    client?.close();
    attached?.kill();
    removeAll();
  });

  // An element of the page by its role, and its text by name, as the observation reads them.
  const element = async (match: { role?: string; name?: string }) => {
    const { targets } = await client.observe(permit, tabId, owner());
    const found = targets.filter(
      (t) =>
        (match.role === undefined || t.role === match.role) &&
        (match.name === undefined || t.name === match.name),
    );
    if (found.length !== 1 || !found[0]?.bbox)
      throw new Error(`no single ${JSON.stringify(match)} among ${targets.length} targets`);
    return { at: found[0].point, box: found[0].bbox };
  };
  const drag = (from: Point, to: Point, durationMs: number, signal?: AbortSignal) =>
    client.input(
      permit,
      tabId,
      {
        input: { kind: "drag", from, to, button: "left", durationMs },
        injector: "xtest",
        holdMs: 0,
      },
      owner(signal),
    );

  it("lands a drag on the page where its points are, through the page's own geometry", async () => {
    expect(await title()).toBe("range 0 order ABG");
    const slider = await element({ role: "slider" });
    // The thumb at 0 sits at the track's left end; 80% along is about 80.
    const left = { x: slider.box.x + 4, y: slider.at.y };
    const receipt = await drag(left, { x: left.x + slider.box.w * 0.8, y: left.y }, 600);
    expect(receipt.presses).toHaveLength(1);
    await sleep(500);
    const value = Number(/range (\d+)/.exec(await title())?.[1]);
    console.log(`range after the drag: ${value}`);
    expect(value).toBeGreaterThanOrEqual(70);
    expect(value).toBeLessThanOrEqual(90);
  });

  it("cancels a stopped drag where it is and drops nothing, then a whole one reorders the list", async () => {
    const alpha = (await element({ name: "Alpha" })).at;
    const gamma = (await element({ name: "Gamma" })).at;
    const stop = new AbortController();
    const stopping = drag(alpha, gamma, 4000, stop.signal).catch((error: unknown) => error);
    await sleep(2200);
    stop.abort();
    expect(await stopping).toBeInstanceOf(BrowserClientError);
    await sleep(1500);
    expect(await title()).toMatch(/ order ABG$/);
    await drag(alpha, gamma, 900);
    await sleep(800);
    expect(await title()).toMatch(/ order BGA$/);
  });
});
