import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EvalCell, removeEvalContainers, startEvalCell } from "../agent/evals/cell.ts";
import { BrowserClient, type BrowserScope } from "../browser/client.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { DockerClient } from "./docker.ts";
import { ISOLATED_GATEWAY_OPTION } from "./spec.ts";
import { DOCKER_TESTS, docker, dockerExec, publishedPort } from "./testing/docker-cli.ts";

// Log in once in a real browser cell, then keep the sign-in through a stopped browser, a new
// browser cell (as after Replace computer), the move from a computer's own old profile into the
// shared one, and a restarted computer whose desktop can neither mount nor reach it. The browser
// sits alone with a stand-in gate on an isolated internal network, as in production; the gate
// serves a tiny site that sets a cookie and forwards browserd to the host. Opt in with
// LOCALDOT_DOCKER_TESTS=1, with LOCALDOT_BROWSER_IMAGE and LOCALDOT_DESKTOP_IMAGE naming images
// built from this tree.
const PREFIX = process.env.LOCALDOT_ACCOUNTS_TEST_PREFIX || "ldtest-accounts-";
const LABEL = process.env.LOCALDOT_ACCOUNTS_TEST_LABEL || "dev.localdot.test=accounts";
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE ?? "";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE ?? "";
const PORT = process.env.LOCALDOT_ACCOUNTS_TEST_PORT ?? "";
const SUBNET = "10.231.79";
const BROWSER_IP = `${SUBNET}.3`;
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const COOKIE = "session=signed-in-for-test";

const SITE = `
import http.server, socket, threading
def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
def forward():
    server = socket.create_server(("0.0.0.0", 7701))
    while True:
        client, _ = server.accept()
        try:
            upstream = socket.create_connection(("${BROWSER_IP}", 7700), timeout=5)
        except OSError:
            client.close()
            continue
        for a, b in ((client, upstream), (upstream, client)):
            threading.Thread(target=pipe, args=(a, b), daemon=True).start()
threading.Thread(target=forward, daemon=True).start()
class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        host = self.headers.get("host", "")
        cookie = self.headers.get("cookie") or "none"
        body = ""
        self.send_response(200)
        if self.path.endswith("/login"):
            self.send_header("set-cookie", "${COOKIE}; Max-Age=31536000; Path=/")
            body = "<title>signed in at " + host + "</title>"
        else:
            body = "<title>cookie " + cookie + "</title>"
        data = body.encode()
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Site).serve_forever()
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(32).toString("base64url");

function caCertificate(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-accounts-ca-"));
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localdot accounts test gate",
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

interface Running {
  name: string;
  client: BrowserClient;
  permit: Parameters<BrowserClient["navigate"]>[0];
  tab: string;
  attached: ChildProcess;
}

describe.skipIf(!DOCKER_TESTS)("sign-ins persist in the shared browser profile", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-accounts-home-"));
  const profile = new AccountsProfile({
    home,
    docker: new DockerClient(),
    prefix: PREFIX,
    image: () => IMAGE,
  });
  const names = {
    network: `${PREFIX}accountsnet`,
    outside: `${PREFIX}accountsout`,
    gate: `${PREFIX}accountsgate`,
    legacy: `${PREFIX}profile-${ulid()}`,
    crashed: `${PREFIX}crashed`,
    accounts: profile.volume,
    desktop: "desk",
  };
  const lifetime = new AbortController();
  const scope: BrowserScope = { signal: lifetime.signal, check: () => {} };
  const browsers: string[] = [];
  let computer: EvalCell | undefined;

  const removeAll = () => {
    const sh = (command: string) =>
      execFileSync("sh", ["-c", `${command} >/dev/null 2>&1 || true`]);
    for (const name of [...browsers, names.gate, `${names.accounts}-copy`])
      sh(`docker rm -fv ${name}`);
    removeEvalContainers({ label: LABEL, namePrefix: PREFIX }, `${PREFIX}${names.desktop}`);
    sh(`docker network rm ${names.network} ${names.outside}`);
    sh(`docker volume rm ${names.legacy} ${names.accounts} ${names.crashed}`);
  };

  async function startBrowser(volume: string): Promise<Running> {
    const browserCellId = ulid(),
      parentCellId = ulid(),
      serviceToken = token();
    const name = `${PREFIX}browser${browsers.length}`;
    browsers.push(name);
    docker(
      "create",
      "-i",
      "--name",
      name,
      "--label",
      LABEL,
      "--hostname",
      `browser-${browserCellId.toLowerCase()}`,
      "--network",
      names.network,
      "--ip",
      BROWSER_IP,
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
      "--mount",
      `type=volume,source=${volume},target=/profile`,
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
      "LOCALDOT_SCALE=1",
      "-e",
      "LOCALDOT_STREAM_FULLCOLOR=0",
      IMAGE,
    );
    const attached = spawn("docker", ["start", "-a", "-i", name], {
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
    const baseUrl = `http://127.0.0.1:${publishedPort(names.gate, "7701")}`;
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
    if (!instance) throw new Error(`browserd in ${name} did not become ready`);
    const client = new BrowserClient({
      browserCellId,
      parentCellId,
      instance,
      browserd: { baseUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    });
    const permit = {
      browserCellId,
      parentCellId,
      instance,
      revision: 1,
      requestId: ulid(),
      owner: { sessionId: ulid(), generation: 1 },
    };
    await client.control({ ...permit, holder: "agent" }, scope);
    let tab = "";
    for (let i = 0; i < 40 && !tab; i++) {
      tab = (await client.tabs(scope)).tabs.find((entry) => entry.ready)?.id ?? "";
      if (!tab) await sleep(250);
    }
    return { name, client, permit, tab, attached };
  }

  // As the orchestrator stops a browser: SIGTERM, so Chromium closes and writes its profile.
  // Killed, it dies as when Docker or the Mac goes down under it.
  function stopBrowser(running: Running, kill = false) {
    running.client.close();
    if (kill) docker("kill", running.name);
    else docker("stop", "-t", "10", running.name);
    running.attached.kill();
    docker("rm", "-fv", running.name);
  }

  async function title(running: Running, url: string): Promise<string> {
    await running.client.navigate(running.permit, running.tab, url, scope);
    for (let i = 0; i < 40; i++) {
      const page = await running.client.read(running.permit, running.tab, { maxChars: 500 }, scope);
      if (page.url.startsWith(url) && page.title) return page.title;
      await sleep(250);
    }
    throw new Error(`${url} did not load`);
  }

  beforeAll(async () => {
    if (!IMAGE || !DESKTOP_IMAGE)
      throw new Error(
        "Set LOCALDOT_BROWSER_IMAGE and LOCALDOT_DESKTOP_IMAGE to images built from this tree.",
      );
    removeAll();
    docker(
      "network",
      "create",
      "--label",
      LABEL,
      "--internal",
      "--opt",
      `${ISOLATED_GATEWAY_OPTION}=isolated`,
      "--subnet",
      `${SUBNET}.0/24`,
      names.network,
    );
    docker("network", "create", "--label", LABEL, names.outside);
    docker(
      "create",
      "--name",
      names.gate,
      "--label",
      LABEL,
      "--network",
      names.outside,
      "-p",
      `127.0.0.1:${PORT}:7701`,
      "--entrypoint",
      "/usr/bin/python3",
      DESKTOP_IMAGE,
      "-c",
      SITE,
    );
    docker("network", "connect", "--ip", `${SUBNET}.2`, names.network, names.gate);
    docker("start", names.gate);
    docker(
      "volume",
      "create",
      "--label",
      LABEL,
      "--label",
      "localdot.role=profile",
      "--label",
      `localdot.cell=${names.legacy.slice(-26)}`,
      names.legacy,
    );
  }, 300_000);

  afterAll(() => {
    lifetime.abort();
    removeAll();
    rmSync(home, { recursive: true, force: true });
  });

  it("logs in on a computer's own old profile, which then moves into the shared one", async () => {
    const first = await startBrowser(names.legacy);
    expect(await title(first, "http://login.localdot.test/login")).toBe(
      "signed in at login.localdot.test",
    );
    expect(await title(first, "http://login.localdot.test/whoami")).toBe(`cookie ${COOKIE}`);
    expect(await first.client.cookieDomains(scope)).toContainEqual({
      domain: "login.localdot.test",
      count: 1,
    });
    stopBrowser(first);
    // A browser cell that died without Chromium's own exit leaves its lock behind.
    docker(
      "run",
      "--rm",
      "--name",
      `${PREFIX}lock`,
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--label",
      LABEL,
      "--mount",
      `type=volume,source=${names.legacy},target=/profile`,
      "--entrypoint",
      "/bin/ln",
      IMAGE,
      "-sfn",
      "browser-01jxyz0000000000000000000z-4242",
      "/profile/chromium/SingletonLock",
    );
    await profile.ensure([names.legacy]);
    expect(docker("volume", "inspect", "-f", "{{json .Labels}}", names.accounts)).toContain(
      '"localdot.role":"accounts-profile"',
    );
  }, 300_000);

  it("keeps the sign-in in a new browser cell, signs out of one site only, and survives a restart", async () => {
    const second = await startBrowser(names.accounts);
    expect(await title(second, "http://login.localdot.test/whoami")).toBe(`cookie ${COOKIE}`);
    expect(await title(second, "http://news.example.test/login")).toBe(
      "signed in at news.example.test",
    );
    expect(await second.client.signOut("example.test", scope)).toBe(1);
    const domains = await second.client.cookieDomains(scope);
    expect(domains.map((entry) => entry.domain)).toEqual(["login.localdot.test"]);
    expect(await title(second, "http://news.example.test/whoami")).toBe("cookie none");
    stopBrowser(second);
    const third = await startBrowser(names.accounts);
    expect(await title(third, "http://login.localdot.test/whoami")).toBe(`cookie ${COOKIE}`);
    stopBrowser(third);
  }, 600_000);

  // After one unclean exit Chromium asks to restore pages on every start until someone answers,
  // and while it asks, neither dot nor a sign-in can be shown the browser's screen.
  it("shows the browser's screen in every cell after one that died without closing Chromium", async () => {
    docker("volume", "create", "--label", LABEL, names.crashed);
    const killed = await startBrowser(names.crashed);
    // Chromium records a running session in the profile some seconds after it starts.
    const recorded = () =>
      dockerExec(killed.name, "cat", "/profile/chromium/Default/Preferences").out.includes(
        '"exit_type":"Crashed"',
      );
    for (let i = 0; i < 60 && !recorded(); i++) await sleep(500);
    stopBrowser(killed, true);
    for (let restarts = 0; restarts < 2; restarts++) {
      const running = await startBrowser(names.crashed);
      await expect(running.client.clock(running.permit, running.tab, scope)).resolves.toMatchObject(
        { mono: expect.any(Number) },
      );
      stopBrowser(running);
    }
  }, 600_000);

  it("leaves the computer, before and after a restart, with no way to the sign-ins", async () => {
    computer = await startEvalCell(names.desktop, {
      image: DESKTOP_IMAGE,
      label: LABEL,
      namePrefix: PREFIX,
      scale: 1,
      desktopdPort: 0,
    });
    const running = await startBrowser(names.accounts);
    const check = (cell: EvalCell) => {
      const mounts = docker("inspect", "-f", "{{json .Mounts}}", cell.name);
      expect(mounts).not.toContain(names.accounts);
      expect(mounts).not.toContain(names.legacy);
      const found = cell.exec([
        "sh",
        "-c",
        "grep -rls signed-in-for-test /config /tmp /run /home 2>/dev/null; true",
      ]);
      expect(found.out.trim()).toBe("");
      expect(cell.exec(["ls", "/profile"]).status).not.toBe(0);
      const reach = cell.exec([
        "sh",
        "-c",
        `curl -s -m 3 -o /dev/null -w '%{http_code}' http://${BROWSER_IP}:7700/health || echo unreachable`,
      ]);
      expect(reach.out).toContain("unreachable");
    };
    check(computer);
    docker("restart", "-t", "10", computer.name);
    await sleep(5000);
    check(computer);
    expect(await title(running, "http://login.localdot.test/whoami")).toBe(`cookie ${COOKIE}`);
    stopBrowser(running);
  }, 600_000);
});
