import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserClient, type BrowserScope } from "../browser/client.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// A new conversation's task opens a blank tab in a real browser cell, run as the orchestrator runs
// one, with a stand-in gate that answers every page with the earlier task's page. That page stays
// open behind the blank tab, as the earlier task left it, and the user can go back to it.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.231.83";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const PAGE_URL = "http://earlier.localdot.test/";
const NOTE = "typed before the new conversation";

// Painted the colour the test looks for, with a field whose text becomes the title.
const PAGE = `<!doctype html><title>Earlier page</title><body style="margin:0;background:rgb(20,180,210)">
<input aria-label="Note" style="position:absolute;left:100px;top:100px;width:400px;height:40px">
<script>document.querySelector('input').addEventListener('input', e => { document.title = e.target.value; });</script>
</body>`;
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

describe.skipIf(!DOCKER_TESTS)("a blank tab for a new conversation in a real browser cell", () => {
  const names = scope && {
    network: `${scope.namePrefix}freshtab-net`,
    gate: `${scope.namePrefix}freshtab-gate`,
    browser: `${scope.namePrefix}freshtab-browser`,
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
  let earlier = "";
  let blank = "";

  // Control as the daemon hands it over: to a task's agent, or to the user.
  const grant = async (holder: "agent" | "user") => {
    const request = { ...identity, revision: ++revision, requestId: ulid() };
    const agent = { ...request, owner: { sessionId: ulid(), generation: 1 } };
    await client.control(holder === "agent" ? { ...agent, holder } : { ...request, holder }, owner);
    return { permit: agent, manual: request };
  };
  // A read of a tab that waits for it to come to the front and settle.
  const inFront = async (permit: Parameters<BrowserClient["clock"]>[0], tabId: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.clock(permit, tabId, owner);
        return await client.read(permit, tabId, { maxChars: 500 }, owner);
      } catch (error) {
        if (attempt >= 40) throw error;
        await sleep(250);
      }
    }
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
    identity = { browserCellId, parentCellId, instance };
    client = new BrowserClient({
      ...identity,
      browserd: { baseUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    });
    // The earlier task: it opens its page in the startup tab and types into it.
    const { permit } = await grant("agent");
    for (let i = 0; i < 40 && !earlier; i++) {
      earlier = (await client.tabs(owner)).tabs.find((tab) => tab.ready)?.id ?? "";
      if (!earlier) await sleep(250);
    }
    await inFront(permit, earlier);
    await client.navigate(permit, earlier, PAGE_URL, owner);
    expect((await inFront(permit, earlier)).title).toBe("Earlier page");
    const { targets } = await client.observe(permit, earlier, owner);
    const note = targets.find((target) => target.name === "Note");
    if (!note) throw new Error("the page's field is missing");
    await client.input(
      permit,
      earlier,
      {
        input: { kind: "click", at: note.point, button: "left", count: 1 },
        injector: "xtest",
        holdMs: 0,
      },
      owner,
    );
    await client.type(
      permit,
      earlier,
      {
        text: NOTE,
        masked: false,
        injector: "xtest",
        pace: { firstCount: 0, firstMs: 0, restMs: 0 },
      },
      owner,
      () => {},
    );
    expect((await inFront(permit, earlier)).title).toBe(NOTE);
  }, 240_000);

  afterAll(() => {
    lifetime.abort();
    client?.close();
    attached?.kill();
    removeAll();
  });

  // Pixels of the earlier page's colour in what the agent sees.
  const earlierPixels = async (image: string) => {
    const { data, info } = await sharp(Buffer.from(image, "base64"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let offset = 0; offset < data.length; offset += info.channels)
      if (
        Math.abs((data[offset] ?? 0) - 20) < 25 &&
        Math.abs((data[offset + 1] ?? 0) - 180) < 25 &&
        Math.abs((data[offset + 2] ?? 0) - 210) < 25
      )
        count++;
    return count;
  };

  it("shows the next conversation's task a blank tab, the earlier page open behind it", async () => {
    const { permit } = await grant("agent");
    expect(
      await earlierPixels((await client.observe(permit, earlier, owner)).frame.image),
    ).toBeGreaterThan(100_000);
    blank = await client.openTab(permit, owner);
    expect(blank).not.toBe(earlier);
    const page = await inFront(permit, blank);
    expect(page.url).toBe("about:blank");
    expect(page.text.trim()).toBe("");
    expect(
      await earlierPixels((await client.observe(permit, blank, owner)).frame.image),
    ).toBeLessThan(1000);
    expect((await client.tabs(owner)).tabs).toEqual(
      expect.arrayContaining([
        { id: earlier, ready: true },
        { id: blank, ready: true },
      ]),
    );
    expect((await client.tabs(owner)).tabs).toHaveLength(2);
    // The earlier page is behind: the agent can't act on it.
    await expect(client.clock(permit, earlier, owner)).rejects.toMatchObject({ code: "refused" });
    expect((await client.health(owner)).ready).toBe(true);
  });

  it("keeps the earlier page as it was, for the user to go back to", async () => {
    const { manual } = await grant("user");
    // Ctrl+1: Chromium's first tab, which held the earlier task's page.
    await client.manual(manual, { kind: "key", combo: ["ctrl", "1"] }, owner);
    const { permit } = await grant("agent");
    const page = await inFront(permit, earlier);
    expect(page.url).toBe(PAGE_URL);
    expect(page.title).toBe(NOTE);
    await expect(client.clock(permit, blank, owner)).rejects.toMatchObject({ code: "refused" });
  });

  it("brings the blank tab already open forward instead of opening another", async () => {
    const { permit } = await grant("agent");
    expect(await client.openTab(permit, owner)).toBe(blank);
    expect((await inFront(permit, blank)).url).toBe("about:blank");
    expect((await client.tabs(owner)).tabs).toHaveLength(2);
  });
});
