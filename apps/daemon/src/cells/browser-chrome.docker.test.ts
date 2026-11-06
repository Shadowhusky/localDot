import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserClient, type BrowserScope } from "../browser/client.ts";
import { browserInUseCheck } from "../doctor-browser.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserEngine, BrowserEngineRefusal, browserEngineOwner } from "./browser-engine.ts";
import { removeChromeImages } from "./chrome-image.ts";
import { DockerClient, dockerSocketPath } from "./docker.ts";
import { DOCKER_TESTS, docker, dockerLogs, publishedPort } from "./testing/docker-cli.ts";

// A real browser cell, on real Chromium and on the real Chrome image the daemon installs, with a real
// profile volume. The stand-in gate serves the pages and logs what a site sees.
// The gate terminates TLS for the test site with its own CA, as the real gate does for hosts bound to
// saved keys, so this also proves Chrome trusts the cell's CA. No real account is involved.
const BASE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const REPOSITORY = process.env.LOCALDOT_CHROME_TEST_REPOSITORY || "localdot-test/browser-chrome";
const PREFIX = `ldtest-qa10chrome${randomBytes(3).toString("hex")}-`;
const SUBNET = "10.231.91";
const SECCOMP_PATH = join(import.meta.dirname, "browser-seccomp.json");
const SECCOMP = readFileSync(SECCOMP_PATH, "utf8");
const TIMEZONE = "Asia/Tokyo";
const HOST = "fingerprint.localdot.test";
const SITE = `https://${HOST}`;

const FINGERPRINT = `<!doctype html><title>Fingerprint</title><body><script>
(async () => {
  const n = navigator, r = {};
  const attempt = async (name, read) => { try { r[name] = await read(); } catch (e) { r[name] = 'threw ' + e.name; } };
  Object.assign(r, { userAgent: n.userAgent, webdriver: n.webdriver, language: n.language, languages: n.languages,
    platform: n.platform, vendor: n.vendor, cores: n.hardwareConcurrency, memory: n.deviceMemory, touch: n.maxTouchPoints,
    pdfViewer: n.pdfViewerEnabled, plugins: [...n.plugins].map(p => p.name), secure: isSecureContext,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, chrome: typeof window.chrome, chromeRuntime: typeof window.chrome?.runtime,
    leaks: Object.keys(window).filter(k => /^cdc_|^\\$cdc|webdriver|selenium|playwright|puppeteer/i.test(k)),
    screen: [screen.width, screen.height, screen.colorDepth, devicePixelRatio], notification: Notification.permission });
  await attempt('brands', () => n.userAgentData.brands);
  await attempt('hints', () => n.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','fullVersionList','wow64']));
  await attempt('webgl', () => { const gl = document.createElement('canvas').getContext('webgl'); const i = gl.getExtension('WEBGL_debug_renderer_info');
    return { vendor: gl.getParameter(i.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(i.UNMASKED_RENDERER_WEBGL), webgl2: !!document.createElement('canvas').getContext('webgl2') }; });
  const fonts = {};
  for (const family of ['Liberation Sans','Liberation Serif','DejaVu Sans']) {
    const width = (f) => { const c = document.createElement('canvas').getContext('2d'); c.font = '40px ' + f; return c.measureText('mmmmmmmmmmlli').width; };
    fonts[family] = width('"' + family + '", monospace') !== width('monospace');
  }
  r.fonts = fonts;
  const v = document.createElement('video');
  r.codecs = { h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'), aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    vp9: v.canPlayType('video/webm; codecs="vp9"'), av1: v.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
    hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') };
  await attempt('widevine', async () => { await n.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'],
    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]); return true; });
  await fetch('/report', { method: 'POST', body: JSON.stringify(r) });
  document.title = 'Reported';
})();
</script></body>`;

// Logs one JSON line per request, with the headers a site sees.
const GATE = `
import http.server, json, os, ssl
page = ${JSON.stringify(FINGERPRINT)}.encode()
with open("/tmp/leaf.pem", "w") as chain:
    chain.write(os.environ["LEAF"])
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/tmp/leaf.pem")
def respond(handler, body, cookie=None):
    handler.send_response(200)
    handler.send_header("content-type", "text/html; charset=utf-8")
    handler.send_header("accept-ch", "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Model")
    if cookie: handler.send_header("set-cookie", cookie)
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
class Gate(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log(self, **fields):
        print("GATE " + json.dumps({"path": self.path, "headers": dict(self.headers.items()), **fields}), flush=True)
    def do_CONNECT(self):
        self.send_response(200, "Connection Established")
        self.end_headers()
        tls = context.wrap_socket(self.connection, server_side=True)
        Gate(tls, self.client_address, self.server)
        self.close_connection = True
    def do_POST(self):
        size = int(self.headers.get("content-length", 0))
        self.log(report=json.loads(self.rfile.read(size)))
        respond(self, b"ok")
    def do_GET(self):
        self.log()
        path = self.path
        if path.startswith("/fingerprint"):
            return respond(self, page)
        if path.startswith("/signed-in/"):
            name = path.split("/")[-1]
            return respond(self, b"<!doctype html><title>Signed in</title>", "session=" + name + "; Max-Age=86400; Path=/; SameSite=Lax")
        respond(self, b"<!doctype html><title>Echo</title>")
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(32).toString("base64url");
function gateCertificates(): { ca: string; leaf: string } {
  const dir = mkdtempSync(join(tmpdir(), "localdot-chrome-ca-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  try {
    openssl(
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
      join(dir, "ca-key.pem"),
      "-out",
      join(dir, "ca.pem"),
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    );
    openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${HOST}`,
      "-keyout",
      join(dir, "leaf-key.pem"),
      "-out",
      join(dir, "leaf.csr"),
    );
    writeFileSync(join(dir, "san.cnf"), `subjectAltName=DNS:${HOST}\n`);
    openssl(
      "x509",
      "-req",
      "-in",
      join(dir, "leaf.csr"),
      "-CA",
      join(dir, "ca.pem"),
      "-CAkey",
      join(dir, "ca-key.pem"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      join(dir, "san.cnf"),
      "-out",
      join(dir, "leaf.pem"),
    );
    return {
      ca: readFileSync(join(dir, "ca.pem"), "utf8"),
      leaf: `${readFileSync(join(dir, "leaf.pem"), "utf8")}${readFileSync(join(dir, "leaf-key.pem"), "utf8")}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Cell {
  client: BrowserClient;
  identity: { browserCellId: string; parentCellId: string; instance: string };
  name: string;
  readyMs: number;
  stop(): void;
}

describe.skipIf(!DOCKER_TESTS)("Chrome as the web browser, in a real browser cell", () => {
  const client = new DockerClient(dockerSocketPath());
  const home = realpathSync(mkdtempSync(join(tmpdir(), "localdot-chrome-home-")));
  const restarts: string[] = [];
  const accounts = new AccountsProfile({ home, docker: client, prefix: PREFIX, image: () => BASE });
  const engine = new BrowserEngine({
    home,
    docker: client,
    prefix: PREFIX,
    seccomp: SECCOMP,
    base: () => BASE,
    accounts,
    restart: (reason) => restarts.push(reason),
    repository: REPOSITORY,
  });
  const network = `${PREFIX}net`;
  const gate = `${PREFIX}gate`;
  const certificates = DOCKER_TESTS ? gateCertificates() : { ca: "", leaf: "" };
  const lifetime = new AbortController();
  const owner: BrowserScope = {
    signal: lifetime.signal,
    check: () => lifetime.signal.throwIfAborted(),
  };
  let attached: ChildProcess | undefined;

  const gateLines = () =>
    dockerLogs(gate)
      .split("\n")
      .filter((line) => line.startsWith("GATE "))
      .map((line) => JSON.parse(line.slice(5)));

  // On a machine under heavy load the window manager's cold start can miss browserd's start deadline
  // (49 s was measured at a load of 75), which the daemon's own retries also meet. That isn't what is
  // under test here.
  const startCell = async (image: string): Promise<Cell> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await tryCell(image);
      } catch (error) {
        spawnSync("docker", ["rm", "-fv", `${PREFIX}browser`], { stdio: "ignore" });
        if (attempt >= 6 || !/could not start /u.test(String(error))) throw error;
      }
    }
  };

  // Run as the daemon runs one: the same user, read-only root, capabilities, seccomp and tmpfs.
  const tryCell = async (image: string): Promise<Cell> => {
    const name = `${PREFIX}browser`;
    const browserCellId = ulid();
    const parentCellId = ulid();
    const serviceToken = token();
    docker(
      "create",
      "-i",
      "--name",
      name,
      "--network",
      network,
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
      `seccomp=${SECCOMP_PATH}`,
      "--init",
      "--memory",
      String(1400 * 1024 ** 2),
      "--memory-swap",
      String(1400 * 1024 ** 2),
      "--pids-limit",
      "1024",
      "--cpu-shares",
      "2048",
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
      `type=volume,source=${accounts.volume},target=/profile`,
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
      "-e",
      `LOCALDOT_BROWSER_TZ=${TIMEZONE}`,
      image,
    );
    const started = Date.now();
    attached = spawn("docker", ["start", "-a", "-i", name], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    attached.stdin?.end(
      JSON.stringify({
        v: 1,
        browserCellId,
        parentCellId,
        proxyToken: token(),
        caCertPem: certificates.ca,
      }),
    );
    let port = 0;
    for (let i = 0; i < 60 && !port; i++) {
      try {
        port = publishedPort(name, "7700");
      } catch {
        await sleep(250);
      }
    }
    if (!port) throw new Error("browserd is not published");
    const baseUrl = `http://127.0.0.1:${port}`;
    let instance = "";
    for (const deadline = Date.now() + 70_000; Date.now() < deadline && !instance; ) {
      try {
        const reply = await fetch(`${baseUrl}/health`, {
          headers: { authorization: `Bearer ${serviceToken}` },
          signal: AbortSignal.timeout(2000),
        });
        const body = (await reply.json()) as { ready?: boolean; instance?: string };
        if (reply.ok && body.ready && body.instance) instance = body.instance;
      } catch {
        // browserd is still starting
      }
      if (!instance) await sleep(100);
    }
    if (!instance)
      throw new Error(`browserd did not become ready: ${dockerLogs(name).slice(-800)}`);
    const readyMs = Date.now() - started;
    const browser = new BrowserClient({
      browserCellId,
      parentCellId,
      instance,
      browserd: { baseUrl, token: serviceToken },
      stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic none" },
    });
    return {
      client: browser,
      identity: { browserCellId, parentCellId, instance },
      name,
      readyMs,
      stop: () => {
        browser.close();
        spawnSync("docker", ["stop", "-t", "20", name], { stdio: "ignore" });
        attached?.kill();
        spawnSync("docker", ["rm", "-fv", name], { stdio: "ignore" });
      },
    };
  };

  // The cookie store on the volume, read without opening it in a browser.
  const savedCookieHosts = () =>
    Number(
      docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${accounts.volume},target=/saved,readonly`,
        "--entrypoint",
        "/bin/sh",
        BASE,
        "-c",
        `grep -ac ${HOST} /saved/chromium/Default/Cookies || true`,
      ),
    );

  const visit = async (cell: Cell, url: string, title: string) => {
    const permit = {
      ...cell.identity,
      revision: Date.now(),
      requestId: ulid(),
      owner: { sessionId: ulid(), generation: 1 },
    };
    await cell.client.control({ ...permit, holder: "agent" }, owner);
    let tab = "";
    for (let i = 0; i < 60 && !tab; i++) {
      tab = (await cell.client.tabs(owner)).tabs.find((entry) => entry.ready)?.id ?? "";
      if (!tab) await sleep(250);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await cell.client.clock(permit, tab, owner);
        break;
      } catch (error) {
        if (attempt >= 60) throw error;
        await sleep(250);
      }
    }
    await cell.client.navigate(permit, tab, url, owner);
    for (let attempt = 0; ; attempt++) {
      try {
        await cell.client.clock(permit, tab, owner);
        const page = await cell.client.read(permit, tab, { maxChars: 500 }, owner);
        if (page.title === title) return page;
      } catch (error) {
        if (attempt >= 60) throw error;
      }
      if (attempt >= 60) throw new Error(`the page never reached "${title}"`);
      await sleep(250);
    }
  };

  beforeAll(() => {
    docker("network", "create", "--subnet", `${SUBNET}.0/24`, network);
    docker(
      "run",
      "-d",
      "--name",
      gate,
      "--network",
      network,
      "--ip",
      `${SUBNET}.2`,
      "--memory",
      String(128 * 1024 ** 2),
      "-e",
      `LEAF=${certificates.leaf}`,
      "--entrypoint",
      "/usr/bin/python3",
      DESKTOP_IMAGE,
      "-c",
      GATE,
    );
    docker(
      "volume",
      "create",
      "--label",
      `localdot.role=accounts-profile`,
      "--label",
      `localdot.accounts-owner=${crypto.randomUUID()}`,
      accounts.volume,
    );
  });

  afterAll(async () => {
    lifetime.abort();
    attached?.kill();
    for (const name of [`${PREFIX}browser`, gate])
      spawnSync("docker", ["rm", "-fv", name], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    for (const volume of [accounts.volume, accounts.backupVolume])
      spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
    await removeChromeImages(client, browserEngineOwner(home)).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });

  it("opens Chromium by default, with nothing asked of Docker until someone chooses Chrome", async () => {
    expect(engine.pinned).toBe(true);
    expect(await engine.image()).toBe(BASE);
    expect((await engine.status()).choice).toBeNull();
    expect((await engine.status()).engine).toBe("chromium");
    expect((await engine.status()).offered).toBe(true);
    const doctor = await browserInUseCheck(client, home, BASE);
    expect(doctor.ok).toBe(true);
    expect(doctor.detail).toMatch(/^Chromium [0-9]+\./u);
  });

  const comparisons: Record<string, unknown> = {};
  const listeningPorts = (table: string) =>
    table
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().split(/\s+/u)[3] === "0A")
      .map((line) => Number.parseInt(line.trim().split(/\s+/u)[1]?.split(":")[1] ?? "0", 16))
      // A helper's ephemeral port, on Chromium too, differs from run to run.
      .map((port) => (port >= 32768 ? 0 : port))
      .sort((a, b) => a - b);
  let chromium: {
    report: Record<string, unknown>;
    flags: string;
    ports: number[];
  };
  const fingerprint = async (label: string, image: string) => {
    const cell = await startCell(image);
    try {
      await visit(cell, `${SITE}/fingerprint`, "Reported");
      await sleep(10_000);
      const memory = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", cell.name);
      const lines = gateLines();
      const report = lines.findLast((line) => line.report)?.report;
      const headers = lines.findLast((line) => /fingerprint/u.test(line.path))?.headers;
      const processes = docker("exec", cell.name, "ps", "-eo", "pid,comm,args", "--cols", "4000");
      const browser = processes
        .split("\n")
        .filter((line) => /\s(?:chromium|chrome)\s/u.test(line) && !line.includes("--type="));
      const renderer = processes.split("\n").find((line) => line.includes("--type=renderer"));
      const rendererPid = renderer?.trim().split(/\s+/u)[0] ?? "";
      const listening = docker("exec", cell.name, "cat", "/proc/net/tcp");
      comparisons[label] = { readyMs: cell.readyMs, memory, report, headers };
      return { cell, report, headers, browser, rendererPid, listening, memory };
    } catch (error) {
      cell.stop();
      throw error;
    }
  };

  it("keeps Chromium's fingerprint as it was", async () => {
    const seen = await fingerprint("chromium", BASE);
    try {
      expect(seen.report.widevine).toMatch(/NotSupportedError/u);
      expect(seen.report.brands.map((brand: { brand: string }) => brand.brand)).toContain(
        "Chromium",
      );
      expect(seen.report.brands.map((brand: { brand: string }) => brand.brand)).not.toContain(
        "Google Chrome",
      );
      expect(seen.browser.join("\n")).toMatch(/\schromium\s/u);
      chromium = {
        report: seen.report,
        flags: seen.browser[0] ?? "",
        ports: listeningPorts(seen.listening),
      };
    } finally {
      seen.cell.stop();
    }
  }, 300_000);

  it("stays on Chromium for someone who declines", async () => {
    await engine.choose({ choice: "chromium" });
    expect((await engine.status()).choice).toBe("chromium");
    expect(await engine.image()).toBe(BASE);
  });

  it("signs in on Chromium, then installs Chrome from Google and hands the sign-ins over", async () => {
    const before = await startCell(BASE);
    try {
      await visit(before, `${SITE}/signed-in/before-chrome`, "Signed in");
      await sleep(2000);
    } finally {
      before.stop();
    }
    expect(savedCookieHosts()).toBeGreaterThan(0);
    const lastUsed = await accounts.lastVersion();
    expect(lastUsed).toMatch(/^[0-9]+\.0\./u);

    await engine.choose({ choice: "chrome", acceptGoogleTerms: true });
    expect((await engine.status()).installing).toBe(true);
    await engine.settled(new AbortController().signal);
    for (let i = 0; i < 300 && (await engine.status()).installing; i++) await sleep(1000);
    const installed = await engine.status();
    expect(installed.problem).toBeUndefined();
    expect(installed.restartNeeded).toBe(true);
    // Nothing is handed over while Chromium might still be open.
    expect(await engine.image()).toBe(BASE);
    expect(await accounts.hasBackup()).toBe(false);

    expect(await engine.handOverPending()).toBe(true);
    await engine.handOver();
    expect(await accounts.hasBackup()).toBe(true);
    const handed = await engine.status();
    expect(handed.engine).toBe("chrome");
    expect(handed.version).toMatch(/^[0-9]+\./u);
    expect(handed.backup?.version).toBe(lastUsed);
    expect(await engine.image()).toMatch(/^sha256:/u);
    const doctor = await browserInUseCheck(client, home, BASE);
    expect(doctor.ok).toBe(true);
    expect(doctor.detail).toContain(`Google Chrome ${handed.version}`);
  }, 900_000);

  it("runs Chrome with the same flags, sandbox and private pipe, and keeps the sign-in", async () => {
    const image = await engine.image();
    const seen = await fingerprint("chrome", image);
    try {
      expect(seen.browser).toHaveLength(1);
      const flags = seen.browser[0] ?? "";
      expect(flags).toMatch(/\schrome\s/u);
      for (const flag of [
        "--remote-debugging-pipe",
        "--user-data-dir=/profile/chromium",
        "--force-renderer-accessibility",
        "--use-angle=gl",
        "--disable-sync",
        "--disable-extensions",
        "--lang=en-US",
        "--proxy-server=http://127.0.0.1:3129",
      ])
        expect(flags).toContain(flag);
      expect(flags).not.toMatch(/remote-debugging-port|enable-automation|no-sandbox|headless/u);

      // The same services listen as on Chromium: Chrome opened no debugging port of its own.
      expect(listeningPorts(seen.listening)).toEqual(chromium.ports);
      const flagsOf = (line: string) =>
        line
          .split(/\s+/u)
          .filter((word) => word.startsWith("--"))
          .sort();
      expect(flagsOf(flags)).toEqual(flagsOf(chromium.flags));

      // The renderer runs inside Chrome's namespace sandbox with seccomp and no new privileges.
      const status = docker("exec", seen.cell.name, "cat", `/proc/${seen.rendererPid}/status`);
      expect(status).toMatch(/^NoNewPrivs:\s+1$/mu);
      expect(status).toMatch(/^Seccomp:\s+2$/mu);
      const namespaces = docker(
        "exec",
        seen.cell.name,
        "readlink",
        `/proc/${seen.rendererPid}/ns/pid`,
      );
      expect(namespaces).not.toBe(docker("exec", seen.cell.name, "readlink", "/proc/self/ns/pid"));

      const { report, headers } = seen;
      expect(report.brands.map((brand: { brand: string }) => brand.brand)).toContain(
        "Google Chrome",
      );
      // navigator.webdriver is true on both while the CDP pipe is open: the same posture as Chromium.
      // Sign-in without agent control, which closes it, is what makes it false.
      for (const field of [
        "userAgent",
        "webdriver",
        "language",
        "languages",
        "platform",
        "vendor",
        "cores",
        "memory",
        "touch",
        "pdfViewer",
        "plugins",
        "secure",
        "timezone",
        "chrome",
        "chromeRuntime",
        "leaks",
        "screen",
        "notification",
        "webgl",
        "fonts",
        "codecs",
      ]) {
        const expected =
          field === "userAgent"
            ? String(chromium.report.userAgent).replace(
                /Chrome\/[0-9]+/u,
                /Chrome\/[0-9]+/u.exec(report.userAgent)?.[0] ?? "",
              )
            : chromium.report[field];
        expect(report[field], field).toEqual(expected);
      }
      expect(report.language).toBe("en-US");
      expect(report.timezone).toBe(TIMEZONE);
      expect(report.leaks).toEqual([]);
      expect(Object.values(report.fonts)).toEqual([true, true, true]);
      expect(report.webgl.renderer).toMatch(/ANGLE|llvmpipe|Mesa/iu);
      expect(report.codecs.h264).toBe("probably");
      expect(report.widevine).toBe(true);
      expect(headers["Accept-Language"]).toMatch(/^en-US/u);
      expect(headers["sec-ch-ua"]).toContain("Google Chrome");

      await visit(seen.cell, `${SITE}/echo-after-handover`, "Echo");
      const echo = gateLines().findLast((line) => /echo-after-handover/u.test(line.path));
      expect(echo?.headers.Cookie).toContain("session=before-chrome");

      await visit(seen.cell, `${SITE}/signed-in/in-chrome`, "Signed in");
      await sleep(2000);
    } finally {
      seen.cell.stop();
      console.log(`COMPARISON ${JSON.stringify(comparisons)}`);
    }
  }, 300_000);

  it("won't let the older Chromium open the profile Chrome has upgraded", async () => {
    const upgraded = await accounts.lastVersion();
    const chromium = (await engine.status()).backup?.version;
    expect(Number(upgraded?.split(".")[0])).toBeGreaterThan(Number(chromium?.split(".")[0]));
    await expect(startCell(BASE)).rejects.toThrow(/older than the one that last opened/u);
    spawnSync("docker", ["rm", "-fv", `${PREFIX}browser`], { stdio: "ignore" });
    expect(await accounts.lastVersion()).toBe(upgraded);
    await expect(engine.choose({ choice: "chromium" })).rejects.toBeInstanceOf(
      BrowserEngineRefusal,
    );
    expect((await engine.status()).engine).toBe("chrome");
  }, 300_000);

  it("goes back to the backup: Chromium opens the sign-ins as they were before Chrome", async () => {
    const version = (await engine.status()).backup?.version;
    await engine.restore();
    expect(await accounts.lastVersion()).toBe(version);
    expect(await accounts.hasBackup()).toBe(false);
    const status = await engine.status();
    expect(status.engine).toBe("chromium");
    expect(status.choice).toBe("chromium");
    expect(await engine.image()).toBe(BASE);
    const cell = await startCell(BASE);
    try {
      await visit(cell, `${SITE}/echo-after-restore`, "Echo");
      const echo = gateLines().findLast((line) => /echo-after-restore/u.test(line.path));
      expect(echo?.headers.Cookie).toContain("session=before-chrome");
      expect(echo?.headers.Cookie).not.toContain("in-chrome");
    } finally {
      cell.stop();
    }
    expect(docker("images", "-q", "--filter", `reference=${REPOSITORY}`)).toBe("");
  }, 300_000);
});
