import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TypeRequest, ulid } from "@localdot/protocol";
import { typingPaceMs } from "@localdot/stage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalCellOptions, removeEvalContainers, startEvalCell } from "../agent/evals/cell.ts";
import { BrowserClient, type BrowserScope } from "../browser/client.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { DOCKER_TESTS, docker, publishedPort } from "./testing/docker-cli.ts";

// Characters per second through the real injectors: a browser cell behind a stand-in gate, and a
// desktop cell, both on this suite's own containers. LOCALDOT_TYPING_OUT=<file> also measures every
// pace at LOCALDOT_TYPING_LENGTHS and appends the rows to the file.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const BROWSER_IMAGE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const SUBNET = "10.231.91";
const SECCOMP = join(import.meta.dirname, "browser-seccomp.json");
const OUT = process.env.LOCALDOT_TYPING_OUT;
const report = (row: Record<string, unknown>) => {
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
};

const FIELD = `<input id="field" aria-label="Field" autofocus style="position:absolute;left:40px;top:40px;width:900px;height:40px;font:18px sans-serif">
<output id="counts" style="position:absolute;left:40px;top:90px">0 0 0</output>
<script>
const seen = { down: 0, up: 0, input: 0 };
const field = document.getElementById('field');
const counts = document.getElementById('counts');
const show = () => { counts.textContent = seen.down + ' ' + seen.up + ' ' + seen.input + ' ' + field.value.length; };
field.addEventListener('keydown', () => { seen.down++; });
field.addEventListener('keyup', () => { seen.up++; show(); });
field.addEventListener('input', () => { seen.input++; show(); });
</script>`;
const SIMPLE = `<!doctype html><title>simple</title><body>${FIELD}</body>`;
// A page the size of a web app: thousands of nodes and a few frames, each read on its own.
const HEAVY = `<!doctype html><title>heavy</title><body>${FIELD}
<iframe src="/child" style="position:absolute;left:40px;top:130px;width:300px;height:60px"></iframe>
<iframe src="/child" style="position:absolute;left:360px;top:130px;width:300px;height:60px"></iframe>
<div id="dense" style="position:absolute;left:40px;top:210px;width:1200px"></div>
<script>
const dense = document.getElementById('dense');
for (let row = 0; row < 60; row++) {
  const line = document.createElement('div');
  for (let cell = 0; cell < 50; cell++) {
    const link = document.createElement('a');
    link.href = '#' + row + '-' + cell; link.textContent = 'x';
    link.style.cssText = 'margin-right:6px;font-size:9px';
    line.append(link);
  }
  dense.append(line);
}
</script></body>`;
// A page that moves focus to a password field partway through a typed text.
const MOVES = `<!doctype html><title>moves</title><body>${FIELD}
<input id="pass" type="password" aria-label="Password" autocomplete="current-password" style="position:absolute;left:40px;top:130px;width:400px;height:40px">
<output id="got" style="position:absolute;left:40px;top:190px">in password 0</output>
<script>
const pass = document.getElementById('pass');
const got = document.getElementById('got');
pass.addEventListener('input', () => { got.textContent = 'in password ' + pass.value.length; });
field.addEventListener('input', () => { if (field.value.length === 10) pass.focus(); });
</script></body>`;
const CHILD = "<!doctype html><title>Child</title><body>Child <input aria-label=Inner></body>";

const gateScript = (cert: string, key: string) => `
import http.server, ssl, urllib.parse
open("/tmp/test-cert.pem", "w").write(${JSON.stringify(cert)})
open("/tmp/test-key.pem", "w").write(${JSON.stringify(key)})
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain("/tmp/test-cert.pem", "/tmp/test-key.pem")
pages = {"/heavy": ${JSON.stringify(HEAVY)}.encode(), "/moves": ${JSON.stringify(MOVES)}.encode(), "/child": ${JSON.stringify(CHILD)}.encode()}
simple = ${JSON.stringify(SIMPLE)}.encode()
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
    def do_GET(self):
        content = pages.get(urllib.parse.urlsplit(self.path).path, simple)
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 3128), Gate).serve_forever()
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => randomBytes(32).toString("base64url");

function caCertificate(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "localdot-typing-ca-"));
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
    "-addext",
    "subjectAltName=DNS:typing.localdot.test",
  ]);
  const result = {
    cert: readFileSync(join(dir, "ca.pem"), "utf8"),
    key: readFileSync(join(dir, "key.pem"), "utf8"),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// What the gateway asks for: watching, not watched, and terminal-style.
const PACES: Record<string, TypeRequest["pace"]> = Object.fromEntries(
  (["watch", "fast", "instant"] as const).map((speed) => [
    speed,
    {
      firstCount: speed === "instant" ? 0 : 60,
      firstMs: typingPaceMs(speed, 0),
      restMs: typingPaceMs(speed, 60),
    },
  ]),
);
const LENGTHS = (process.env.LOCALDOT_TYPING_LENGTHS ?? "40,400,4000").split(",").map(Number);
const text = (length: number) =>
  "the quick brown fox jumps over the lazy dog 0123456789 "
    .repeat(Math.ceil(length / 55))
    .slice(0, length);

describe.skipIf(!DOCKER_TESTS)("typing speed", () => {
  describe("in a browser cell", () => {
    const names = scope && {
      network: `${scope.namePrefix}typenet`,
      gate: `${scope.namePrefix}typegate`,
      browser: `${scope.namePrefix}typebrowser`,
    };
    let attached: ChildProcess | undefined;
    let client: BrowserClient;
    let permit: Parameters<BrowserClient["input"]>[0];
    let tabId = "";
    const lifetime = new AbortController();
    const owner = (): BrowserScope => ({
      signal: lifetime.signal,
      check: () => lifetime.signal.throwIfAborted(),
    });
    const removeAll = () => {
      if (!scope || !names) return;
      for (const name of [names.browser, names.gate])
        execFileSync("sh", ["-c", `docker rm -fv ${name} >/dev/null 2>&1 || true`]);
      execFileSync("sh", ["-c", `docker network rm ${names.network} >/dev/null 2>&1 || true`]);
    };
    const read = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await client.read(permit, tabId, { maxChars: 500 }, owner());
        } catch (error) {
          if (attempt >= 60) throw error;
          await sleep(250);
        }
      }
    };

    beforeAll(async () => {
      if (!scope || !names) return;
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
        "--memory",
        "128m",
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
        "--memory",
        "1500m",
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
        BROWSER_IMAGE,
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
      for (const deadline = Date.now() + 300_000; Date.now() < deadline && !instance; ) {
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
    }, 400_000);

    afterAll(() => {
      lifetime.abort();
      client?.close();
      attached?.kill();
      removeAll();
    });

    const measure = async (
      page: string,
      length: number,
      paceName: string,
      during?: (count: number) => void,
    ) => {
      await client.navigate(permit, tabId, `http://typing.localdot.test/${page}`, owner());
      for (let i = 0; i < 40 && (await read()).title !== page; i++) await sleep(250);
      await sleep(500);
      for (let attempt = 0; ; attempt++) {
        try {
          const { targets } = await client.observe(permit, tabId, owner());
          const field = targets.find((t) => t.name === "Field");
          if (!field) throw new Error("no field");
          await client.input(
            permit,
            tabId,
            {
              input: { kind: "click", at: field.point, button: "left", count: 1 },
              injector: "xtest",
              holdMs: 0,
            },
            owner(),
          );
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await sleep(500);
        }
      }
      const started = performance.now();
      let firstAt = 0;
      let typed = 0;
      let failure: string | undefined;
      try {
        await client.type(
          permit,
          tabId,
          {
            text: text(length),
            masked: false,
            injector: "xtest",
            pace: PACES[paceName] as TypeRequest["pace"],
          },
          owner(),
          ({ count }) => {
            firstAt ||= performance.now();
            typed = count;
            during?.(count);
          },
        );
      } catch (error) {
        failure = String(error);
      }
      const ended = performance.now();
      await sleep(300);
      const shown = await read()
        .then((page) => page.text)
        .catch(() => "");
      const cps = Math.round((typed / (ended - started)) * 10000) / 10;
      report({
        tool: "browser",
        page,
        chars: length,
        pace: paceName,
        ms: Math.round(ended - started),
        cps,
        firstMs: Math.round(firstAt - started),
        typed,
        pageSaw: shown.match(/\d+ \d+ \d+ \d+/)?.[0],
        failure,
      });
      return { typed, failure, shown, cps };
    };

    it("stops at a protected field that takes focus", async () => {
      const { typed, failure, shown } = await measure("moves", 200, "instant");
      expect(failure).toBeTruthy();
      expect(typed).toBeLessThanOrEqual(11);
      expect(shown).toContain("in password 0");
    }, 120_000);

    it("delivers every key of a short and a long text, far faster than anyone types", async () => {
      const short = await measure("simple", 40, "watch");
      expect(short.failure).toBeUndefined();
      expect(short.shown).toContain("40 40 40 40");
      const long = await measure("simple", 1000, "fast");
      expect(long.failure).toBeUndefined();
      expect(long.shown).toContain("1000 1000 1000 1000");
      // Reading the whole page for each key, this was 7 at most; and 1000 keys took over its deadline.
      expect(long.cps).toBeGreaterThan(10);
    }, 300_000);

    it.runIf(OUT)(
      "measures the browser",
      async () => {
        for (const page of ["simple", "heavy"]) {
          for (const paceName of ["watch", "fast", "instant"]) {
            for (const length of LENGTHS) await measure(page, length, paceName);
          }
        }
      },
      3_000_000,
    );

    // Last: it leaves the find bar open.
    it("stops once a full read finds browser UI holding the keys", async () => {
      if (!names) return;
      let moved = 0;
      const { typed, failure, cps } = await measure("simple", 4000, "fast", (count) => {
        if (moved || count < 100) return;
        moved = count;
        execFileSync("docker", [
          "exec",
          "-e",
          "DISPLAY=:1",
          names.browser,
          "xdotool",
          "key",
          "ctrl+f",
        ]);
      });
      report({ tool: "browser", browserUi: { moved, typed, failure, cps } });
      expect(failure).toBeTruthy();
      expect(typed).toBeLessThan(4000);
    }, 180_000);
  });

  describe("in a desktop cell", () => {
    let cell: Awaited<ReturnType<typeof startEvalCell>>;
    let desktop: DesktopdClient;
    beforeAll(async () => {
      if (!scope) return;
      cell = await startEvalCell("typing", { ...scope, image: DESKTOP_IMAGE });
      desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
    }, 240_000);
    afterAll(() => {
      if (scope && cell) removeEvalContainers(scope, cell.name);
    });

    it("types every character of a short and a long text, far faster than anyone types", async () => {
      cell.write("/config/eval/typing.txt", "");
      cell.launch(["mousepad", "/config/eval/typing.txt"]);
      let window: number | undefined;
      for (let i = 0; i < 120 && window === undefined; i++) {
        window = (await desktop.observe()).windows.find((w) => /typing\.txt/.test(w.title))?.id;
        if (window === undefined) await sleep(500);
      }
      if (window === undefined) throw new Error("no Mousepad");
      await sleep(1500);
      const press = (combo: string[]) =>
        desktop.input({ input: { kind: "key", combo }, injector: "xtest", holdMs: 0, window });
      const type = async (length: number, paceName: string, extra = "") => {
        await press(["ctrl", "a"]);
        await press(["Delete"]);
        await sleep(300);
        const started = performance.now();
        let typed = 0;
        let failure: string | undefined;
        const content = text(length) + extra;
        try {
          await desktop.type(
            {
              text: content,
              masked: false,
              injector: "xtest",
              pace: PACES[paceName] as TypeRequest["pace"],
              window,
            },
            ({ count }) => {
              typed = count;
            },
          );
        } catch (error) {
          failure = String(error);
        }
        const cps = Math.round((typed / (performance.now() - started)) * 10000) / 10;
        report({ tool: "desktop", chars: length, pace: paceName, cps, typed, failure });
        return { content, failure };
      };
      // The app may still be working through the keys when its Save comes up.
      const saved = async () => {
        await press(["ctrl", "s"]);
        await sleep(1000);
        return cell.exec(["cat", "/config/eval/typing.txt"]).out.trimEnd();
      };
      const expectSaved = (content: string) =>
        expect.poll(saved, { timeout: 60_000, interval: 1000 }).toBe(content.trimEnd());

      const short = await type(40, "watch");
      expect(short.failure).toBeUndefined();
      await expectSaved(short.content);
      const long = await type(1000, "fast", '\nÉé 中文 ~!@#$%^&*()_+{}|:"<>?\n');
      expect(long.failure).toBeUndefined();
      await expectSaved(long.content);
      if (!OUT) return;
      for (const paceName of ["watch", "fast", "instant"]) {
        for (const length of LENGTHS) await type(length, paceName);
      }
    }, 3_000_000);
  });
});
