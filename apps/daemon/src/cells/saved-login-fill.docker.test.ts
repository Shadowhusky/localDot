import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealLoginImport, ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "../browser/client.ts";
import { fillSavedLogin, type SignInHold, signInPageAsks } from "../browser/saved-login-fill.ts";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd } from "../keyd/testing/keyd-process.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// A real keyd holding a real import, and a real browser cell run as the orchestrator runs one, on a
// network of this suite's own whose stand-in gate answers every host with a local fake sign-in. No
// real account, sign-in page or network is involved. Google's name is only a host this gate answers.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const SUBNET = "10.231.91";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const SITE = "login.fixture.localdot.test";
const OTHER = "evil.fixture.localdot.test";
const STAGED = "staged.fixture.localdot.test";
const PASSWORD = "fixture-Saved-Password-密碼";
const ACCOUNT = "fixture-account@example.com";

const FORM = (action: string, extra = "") => `<!doctype html><html><head><title>sign in</title>
<style>body{margin:0;font:20px sans-serif;background:rgb(20,180,210)}form{position:absolute;left:100px;top:100px;width:320px}input,button{display:block;margin:10px;height:40px;width:300px}</style></head>
<body><form method="post" action="${action}" ${extra}><input name="username" aria-label="Account" autocomplete="username"><input name="password" aria-label="Password" type="password" autocomplete="current-password"><button>Sign in</button></form></body></html>`;
const ACCOUNT_FIRST = `<!doctype html><html><head><title>account first</title><style>input,button{display:block;margin:10px;height:40px;width:300px}</style></head><body><form method="post" action="/next"><input name="username" type="email" autocomplete="username" aria-label="Email"><button>Next</button></form></body></html>`;
const PASSWORD_NEXT = `<!doctype html><html><head><title>password next</title><style>input,button{display:block;margin:10px;height:40px;width:300px}</style></head><body><form method="post" action="/session"><input name="password" type="password" autocomplete="current-password" aria-label="Password"><button>Sign in</button></form></body></html>`;
const HOLD_FILLED = FORM("/session", `onsubmit="event.preventDefault();document.title='held'"`);
const OWN_BROWSER = `<!doctype html><html><head><title>fake google</title></head><body><input type="email" aria-label="Email or phone"></body></html>`;
const OWN_BROWSER_MARK = `<!doctype html><title>marking</title><script>localStorage.setItem('fixture_mode', navigator.webdriver ? 'controlled' : 'manual');location.replace('/own');</script>`;
const OWN_BROWSER_RESULT = `<!doctype html><title>checking</title><script>document.title='mode: ' + localStorage.getItem('fixture_mode');</script>`;
const PASSKEY = `<!doctype html><html><head><title>probing</title></head><body><script>
(async () => {
  const result = { credentials: typeof navigator.credentials, webauthn: typeof PublicKeyCredential };
  try { result.platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { result.platform = String(e); }
  try { result.conditional = await PublicKeyCredential.isConditionalMediationAvailable(); } catch (e) { result.conditional = String(e); }
  try { result.capabilities = await PublicKeyCredential.getClientCapabilities(); } catch (e) { result.capabilities = String(e); }
  document.title = 'probed ' + JSON.stringify(result);
})();
</script></body></html>`;

const gateScript = (cert: string, key: string) => `
import http.server, ssl, urllib.parse
open("/tmp/test-cert.pem", "w").write(${JSON.stringify(cert)})
open("/tmp/test-key.pem", "w").write(${JSON.stringify(key)})
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain("/tmp/test-cert.pem", "/tmp/test-key.pem")
PAGES = {
  "/": ${JSON.stringify(FORM("/session"))},
  "/hold": ${JSON.stringify(HOLD_FILLED)},
  "/first": ${JSON.stringify(ACCOUNT_FIRST)},
  "/own": ${JSON.stringify(OWN_BROWSER)},
  "/own-mark": ${JSON.stringify(OWN_BROWSER_MARK)},
  "/own-result": ${JSON.stringify(OWN_BROWSER_RESULT)},
  "/passkey": ${JSON.stringify(PASSKEY)},
}
seen = []
class Gate(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.flush()
        self.connection = tls.wrap_socket(self.connection, server_side=True)
        self.rfile = self.connection.makefile("rb")
        self.wfile = self.connection.makefile("wb")
        self.close_connection = False
        self.handle_one_request()
    def reply(self, content):
        data = content.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.reply(PAGES.get(urllib.parse.urlsplit(self.path).path, "<title>other</title>"))
    def do_POST(self):
        fields = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("content-length", "0"))).decode())
        path = urllib.parse.urlsplit(self.path).path
        if path == "/next":
            self.reply(${JSON.stringify(PASSWORD_NEXT)})
        elif fields.get("password") == [${JSON.stringify(PASSWORD)}]:
            self.reply("<!doctype html><title>signed in as " + fields.get("username", ["(staged)"])[0] + " on " + self.headers.get("host", "") + "</title>")
        else:
            self.reply("<!doctype html><title>wrong password</title>")
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A person sees the page answer before handing back; a page still on its way when the agent's grant
// returns is reloaded, as any page holding a filled password is.
const settled = () => sleep(1500);
const token = () => randomBytes(32).toString("base64url");

function caCertificate(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "localdot-signin-ca-"));
  execFileSync(
    "openssl",
    [
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
      "-addext",
      `subjectAltName=DNS:${SITE},DNS:${OTHER},DNS:${STAGED},DNS:accounts.google.com`,
    ],
    { stdio: "ignore" },
  );
  const result = {
    cert: readFileSync(join(dir, "ca.pem"), "utf8"),
    key: readFileSync(join(dir, "key.pem"), "utf8"),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe.skipIf(!DOCKER_TESTS)("saved logins, from a real import to a real browser cell", () => {
  const names = scope && {
    network: `${scope.namePrefix}signinnet`,
    gate: `${scope.namePrefix}signingate`,
    browser: `${scope.namePrefix}signinbrowser`,
  };
  let attached: ChildProcess | undefined;
  let client: BrowserClient;
  let keyd: KeydProcess;
  let keys: KeydClient;
  let permit: Parameters<BrowserClient["input"]>[0];
  let tabId = "";
  const lifetime = new AbortController();
  const owner = (signal = lifetime.signal): BrowserScope => ({
    signal,
    check: () => signal.throwIfAborted(),
  });
  const title = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.read(permit, tabId, { maxChars: 500 }, owner())).title;
      } catch (error) {
        if (attempt >= 20) throw error;
        await sleep(250);
      }
    }
  };
  const open = async (url: string, wanted: string | RegExp) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.navigate(permit, tabId, url, owner());
        break;
      } catch (error) {
        if (attempt >= 20) throw error;
        await sleep(250);
      }
    }
    await expect
      .poll(title, { timeout: 15_000 })
      .toMatch(typeof wanted === "string" ? new RegExp(`^${wanted}$`) : wanted);
  };
  // The user takes the browser, as a takeover does, and hands it back to the agent afterwards.
  const holding = async <T>(work: (hold: SignInHold) => Promise<T>): Promise<T> => {
    const { owner: agentOwner, ...identity } = permit;
    const manual = { ...identity, requestId: ulid(), revision: permit.revision + 1 };
    await client.control({ ...manual, holder: "user" }, owner());
    const hold: SignInHold = {
      signInPage: (fields) => client.signInPage(manual, fields, owner()),
      fillSecret: (tab, request) => client.manualSecret(manual, tab, request, owner()),
      input: (input) => client.manual(manual, input, owner()),
      check: () => {},
      secretFilled: () => {},
      selection: { geometry: { scale: 2 } },
    };
    try {
      return await work(hold);
    } finally {
      permit = { ...identity, owner: agentOwner, requestId: ulid(), revision: manual.revision + 1 };
      await client.control({ ...permit, holder: "agent" }, owner());
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
    keyd = await startKeyd();
    keys = new KeydClient(keyd.socketPath);
    removeAll();
    const ca = caCertificate();
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
      IMAGE,
      "-c",
      gateScript(ca.cert, ca.key),
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
    attached = spawn("docker", ["start", "-a", "-i", names.browser], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    attached.stdin?.end(
      JSON.stringify({
        v: 1,
        browserCellId,
        parentCellId,
        proxyToken: token(),
        caCertPem: ca.cert,
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
    for (let attempt = 0; ; attempt++) {
      try {
        await client.read(permit, tabId, { maxChars: 500 }, owner());
        break;
      } catch (error) {
        if (attempt >= 40) throw error;
        await sleep(250);
      }
    }
  }, 240_000);

  afterAll(async () => {
    lifetime.abort();
    client?.close();
    attached?.kill();
    removeAll();
    await keyd?.stop();
  });

  const everything = (values: unknown) => JSON.stringify(values);

  it("imports an export through keyd's own seal", async () => {
    const { sealKey } = await keys.status();
    const file = new TextEncoder().encode(
      [
        "name,url,username,password,note",
        `Site,https://${SITE}/login,${ACCOUNT},"${PASSWORD}",a note`,
        `Staged,https://${STAGED}/first,${ACCOUNT},"${PASSWORD}",a note`,
        `Google,https://accounts.google.com/,${ACCOUNT},"${PASSWORD}",a note`,
      ].join("\n"),
    );
    const summary = await keys.importLogins(await sealLoginImport(sealKey, file));
    expect(summary).toMatchObject({ rows: 3, imported: 3, alreadySaved: 0, skipped: [] });
    expect(everything(summary)).not.toContain(PASSWORD);
  });

  it("offers the saved login on its own site, fills it, and signs in without the agent seeing it", async () => {
    await open(`https://${SITE}/`, "sign in");
    await holding(async (hold) => {
      await expect
        .poll(() => signInPageAsks(hold, keys), { timeout: 10_000, interval: 500 })
        .toEqual({ saved: { site: SITE, username: ACCOUNT } });
      expect(await fillSavedLogin(hold, keys)).toBe("submitted");
      await settled();
    });
    await expect.poll(title, { timeout: 15_000 }).toBe(`signed in as ${ACCOUNT} on ${SITE}`);
    const page = await client.read(permit, tabId, { maxChars: 2000 }, owner());
    const seen = await client.observe(permit, tabId, owner());
    expect(everything(page)).not.toContain(PASSWORD);
    expect(everything(seen)).not.toContain(PASSWORD);
  }, 90_000);

  it("carries one tap across a page that asks for the account first", async () => {
    await open(`https://${STAGED}/first`, "account first");
    await holding(async (hold) => {
      expect(await fillSavedLogin(hold, keys, true)).toBe("no-field");
      expect(await fillSavedLogin(hold, keys)).toBe("account");
      await expect
        .poll(() => fillSavedLogin(hold, keys, true), { timeout: 10_000, interval: 500 })
        .toBe("submitted");
      await settled();
    });
    await expect.poll(title, { timeout: 15_000 }).toBe(`signed in as (staged) on ${STAGED}`);
  }, 90_000);

  it("refuses the wrong site at both ends: no login is read, and browserd won't type it", async () => {
    await open(`https://${OTHER}/`, "sign in");
    await holding(async (hold) => {
      const login = vi.spyOn(keys, "login");
      try {
        expect(await signInPageAsks(hold, keys)).toBeUndefined();
        expect(await fillSavedLogin(hold, keys)).toBe("refused");
        expect(login).not.toHaveBeenCalled();
      } finally {
        login.mockRestore();
      }
      const page = await hold.signInPage(true);
      expect(page?.origin).toBe(`https://${OTHER}`);
      expect(page?.field?.kind).toBe("password");
      if (!page?.field) throw new Error("no field");
      // Even told outright, browserd holds each character to the page's real origin.
      await expect(
        hold.fillSecret(page.tabId, {
          origin: `https://${SITE}`,
          at: page.field.at,
          username: ACCOUNT,
          text: PASSWORD,
        }),
      ).rejects.toBeInstanceOf(BrowserClientError);
    });
    await expect.poll(title, { timeout: 5_000 }).toBe("sign in");
    const fields = await client.observe(permit, tabId, owner());
    expect(everything(fields)).not.toContain(PASSWORD);
  }, 90_000);

  it("reloads a page still holding the filled password before the agent gets the browser back", async () => {
    await open(`https://${SITE}/hold`, "sign in");
    await holding(async (hold) => {
      expect(await fillSavedLogin(hold, keys)).toBe("submitted");
      await settled();
    });
    await expect.poll(title, { timeout: 15_000 }).toBe("sign in");
    const page = await client.read(permit, tabId, { maxChars: 2000 }, owner());
    expect(everything(page)).not.toContain(PASSWORD);
  }, 90_000);

  it("masks a password box in the picture, and shows nothing at all once it holds a password", async () => {
    await open(`https://${SITE}/hold`, "sign in");
    const { targets, frame } = await client.observe(permit, tabId, owner());
    const at = targets.find((target) => target.name === "Protected field")?.point;
    if (!at) throw new Error("no password field");
    const { data, info } = await sharp(Buffer.from(frame.image, "base64"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (Math.floor(y) * info.width + Math.floor(x)) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    const ratio = info.width / 1280;
    expect(pixel(at.x * ratio, at.y * ratio).every((channel) => channel < 15)).toBe(true);
    // Beside the field the page still shows.
    expect(pixel(640 * ratio, 600 * ratio)[2]).toBeGreaterThan(150);
    const login = await keys.login(`https://${SITE}`);
    if (!login) throw new Error("no saved login");
    expect(
      await client.secret(
        permit,
        tabId,
        { origin: `https://${SITE}`, at, username: login.username, text: login.password },
        owner(),
      ),
    ).toMatchObject({ filled: true });
    await sleep(500);
    // ScreenController.privateInput reattaches a recording only once this read succeeds.
    await expect(client.read(permit, tabId, { maxChars: 500 }, owner())).rejects.toMatchObject({
      code: "protected_input",
    });
    await expect(client.observe(permit, tabId, owner())).rejects.toMatchObject({
      code: "protected_input",
    });
    // A hold and hand-back clears it, as it would for the user.
    await holding(async () => {});
    await expect.poll(title, { timeout: 15_000 }).toBe("sign in");
  }, 90_000);

  it("names Google's sign-in as one for sign-in mode, where nothing reads or fills the page", async () => {
    await open("https://accounts.google.com/own", /^fake google$/);
    const { owner: agentOwner, ...identity } = permit;
    const manual = { ...identity, requestId: ulid(), revision: permit.revision + 1 };
    await client.control({ ...manual, holder: "user" }, owner());
    const hold: SignInHold = {
      signInPage: (fields) => client.signInPage(manual, fields, owner()),
      fillSecret: (tab, request) => client.manualSecret(manual, tab, request, owner()),
      input: (input) => client.manual(manual, input, owner()),
      check: () => {},
      secretFilled: () => {},
      selection: { geometry: { scale: 2 } },
    };
    await expect
      .poll(() => signInPageAsks(hold, keys), { timeout: 10_000, interval: 500 })
      .toEqual({ ownBrowser: true });
    const login = vi.spyOn(keys, "login");
    expect(await fillSavedLogin(hold, keys)).toBe("refused");
    expect(login).not.toHaveBeenCalled();
    login.mockRestore();
    expect(await client.signIn(manual, "signin", owner())).toEqual({
      mode: "signin",
      changing: false,
    });
    await expect(client.signInPage(manual, true, owner())).rejects.toBeInstanceOf(
      BrowserClientError,
    );
    await expect(
      client.manualSecret(
        manual,
        tabId,
        { origin: "https://accounts.google.com", at: { x: 100, y: 100 }, text: PASSWORD },
        owner(),
      ),
    ).rejects.toBeInstanceOf(BrowserClientError);
    // The page, opened again by the restored session, saw no agent: nothing is connected to it.
    await sleep(1500);
    await client.manual(manual, { kind: "key", combo: ["Control", "l"] }, owner());
    await client.manual(
      manual,
      { kind: "text", text: "https://accounts.google.com/own-mark" },
      owner(),
    );
    await client.manual(manual, { kind: "key", combo: ["Enter"] }, owner());
    await sleep(2000);
    expect(await client.signIn(manual, "standard", owner())).toEqual({
      mode: "standard",
      changing: false,
    });
    permit = { ...identity, owner: agentOwner, requestId: ulid(), revision: manual.revision + 1 };
    await client.control({ ...permit, holder: "agent" }, owner());
    const resumed = (await client.tabs(owner())).tabs.find((tab) => tab.ready);
    if (!resumed) throw new Error("missing restored tab");
    tabId = resumed.id;
    await open("https://accounts.google.com/own-result", "mode: manual");
  }, 120_000);

  it("has what passkeys need nowhere: no Bluetooth, USB or device authenticator", async () => {
    if (!names) throw new Error("missing fixture");
    await open(`https://${SITE}/passkey`, /^probed /);
    const probe = JSON.parse((await title()).replace(/^probed /, "")) as {
      platform: unknown;
      conditional: unknown;
      capabilities: Record<string, unknown>;
    };
    console.log(`what a page learns of passkeys here: ${JSON.stringify(probe)}`);
    expect(probe.platform).toBe(false);
    expect(probe.capabilities.hybridTransport).toBe(false);
    expect(probe.capabilities.passkeyPlatformAuthenticator).toBe(false);
    const devices = docker(
      "exec",
      names.browser,
      "sh",
      "-c",
      "ls /sys/class/bluetooth /dev/bus/usb /dev/hidraw* 2>&1; which bluetoothd || echo no-bluetoothd",
    );
    console.log(`what the cell has of them: ${devices}`);
    expect(devices).toContain("no-bluetoothd");
    expect(devices).not.toMatch(/^hci\d/mu);
    expect(devices).not.toMatch(/^\/dev\/hidraw\d/mu);
  }, 60_000);
});
