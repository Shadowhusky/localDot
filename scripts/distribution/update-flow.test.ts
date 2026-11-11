import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNet } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "../../apps/cli/node_modules/esbuild/lib/main.js";
import { tarBytes } from "../../apps/cli/src/install/testing/tar-fixture.ts";

// The whole in-app update, in one throwaway installation: the real install.sh, verifier and
// updater, against a local signed catalog, with launchd and Docker faked. What it does not cover:
// real launchd or systemd, a real Docker, and the full app (see docs/packaged-testing.md).
const run = promisify(execFile);
const REPO = join(import.meta.dirname, "../..");
const TARGET = `${process.platform}-${process.arch}`;
const NODE_VERSION = /^NODE_VERSION=(.*)$/m.exec(
  readFileSync(join(REPO, "install.sh"), "utf8"),
)?.[1];
const SERVICES = ["dev.localdot.daemon", "dev.localdot.keyd"];
const version = (n: number) => `0.1.0-rc.${n}`;
const pin = (role: string) => `ghcr.io/shadowhusky/localdot-${role}@sha256:${"a".repeat(64)}`;
const ROLES = ["desktop", "gate", "brain", "browser"];

let bundle: string;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
let archive: Buffer;
let artifact: { url: string; sha512: string; bytes: number; files: Record<string, unknown> };

const CLI = `const [command] = process.argv.slice(2);
import { existsSync, readFileSync } from "node:fs";
const control = process.env.HOME + "/control/";
if (command === "doctor") {
  const code = existsSync(control + "doctor-exit") ? Number(readFileSync(control + "doctor-exit", "utf8")) : 0;
  process.exit(code);
}
if (command === "open") console.log("http://127.0.0.1/#code=x");
`;

beforeAll(async () => {
  bundle = realpathSync(mkdtempSync(join(tmpdir(), "dot-flow-bundle-")));
  const shared = {
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node24",
    logLevel: "silent" as const,
    banner: {
      js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
    },
  };
  await build({
    ...shared,
    entryPoints: [join(REPO, "scripts/distribution/bootstrap.ts")],
    outfile: join(bundle, "bootstrap.mjs"),
    define: {
      __LOCALDOT_DISTRIBUTION_KEY__: JSON.stringify(
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    },
  });
  await build({
    ...shared,
    entryPoints: [join(REPO, "apps/daemon/src/updates/testing/flow-daemon.ts")],
    outfile: join(bundle, "daemon.mjs"),
    external: ["sharp"],
  });
  const pinned = createHash("sha256")
    .update(readFileSync(join(bundle, "bootstrap.mjs")))
    .digest("hex");
  const installer = readFileSync(join(REPO, "install.sh"), "utf8")
    .replace(
      'DEFAULT_PACKAGE_CHANNEL=""',
      'DEFAULT_PACKAGE_CHANNEL="https://downloads.localdot.dev/channels/releases.json"',
    )
    .replace('PACKAGE_BOOTSTRAP_SHA256=""', `PACKAGE_BOOTSTRAP_SHA256="${pinned}"`);
  writeFileSync(join(bundle, "install.sh"), installer);
  const files: Record<string, { body: Buffer; mode: number }> = {
    "install.sh": { body: Buffer.from(installer), mode: 0o700 },
    keyd: { body: Buffer.from("#!/bin/sh\nexec sleep 100000\n"), mode: 0o700 },
    "dist/cli.mjs": { body: Buffer.from(CLI), mode: 0o600 },
    "dist/daemon.mjs": { body: readFileSync(join(bundle, "daemon.mjs")), mode: 0o600 },
    "dist/package-bootstrap.mjs": {
      body: readFileSync(join(bundle, "bootstrap.mjs")),
      mode: 0o600,
    },
    "web/dist/index.html": { body: Buffer.from("<html>localDot</html>"), mode: 0o600 },
    "node_modules/sharp/package.json": { body: Buffer.from("{}"), mode: 0o600 },
    "package.json": { body: Buffer.from('{"name":"localdot","version":"0.0.0"}'), mode: 0o600 },
  };
  // Padding, so a download has bytes to report and drop part-way through.
  files["web/dist/padding.bin"] = {
    body: Buffer.alloc(6 * 1024 * 1024, 1).map((_, i) => (i * 31) % 251),
    mode: 0o600,
  };
  archive = gzipSync(
    Buffer.from(
      tarBytes(
        Object.entries(files).map(([path, { body, mode }]) => ({
          name: `package/${path}`,
          body,
          mode: mode === 0o700 ? 0o755 : 0o644,
        })),
      ),
    ),
    { level: 0 },
  );
  artifact = {
    url: "",
    sha512: createHash("sha512").update(archive).digest("hex"),
    bytes: archive.length,
    files: Object.fromEntries(
      Object.entries(files).map(([path, { body, mode }]) => [
        path,
        { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, mode },
      ]),
    ),
  };
}, 60_000);
afterAll(() => {
  rmSync(bundle, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createNet();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

interface Flow {
  root: string;
  port: number;
  version: number;
  catalog: { dropAt: number; drops: number; stall: boolean; ranges: (string | undefined)[] };
  control(name: string, value: string): void;
  clear(name: string): void;
  status(): Promise<Record<string, unknown> & { phase?: string; error?: string | null }>;
  post(path: string, body?: unknown): Promise<{ status: number; text: string }>;
  stages: string[];
  reached(
    check: (status: Awaited<ReturnType<Flow["status"]>>) => boolean,
    ms?: number,
  ): Promise<Awaited<ReturnType<Flow["status"]>>>;
  log(name: string): string;
  running(): string;
}
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function installation(start = 90): Promise<Flow> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dot-flow-")));
  chmodSync(root, 0o700);
  const home = join(root, "h"),
    data = join(root, "d"),
    prefix = join(root, "p"),
    fake = join(root, "bin");
  for (const dir of [home, fake, join(home, "control"), join(home, "services")])
    mkdirSync(dir, { recursive: true });
  const catalogPort = await freePort(),
    port = await freePort();
  const flow = {
    version: start,
    catalog: { dropAt: 0, drops: 0, stall: false, ranges: [] as (string | undefined)[] },
  };
  const signed = () => {
    const name = version(flow.version);
    const images = Object.fromEntries(ROLES.map((role) => [role, pin(role)]));
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        version: name,
        commit: "c".repeat(40),
        platforms: {
          [TARGET]: {
            ...artifact,
            url: `https://github.com/Shadowhusky/localdot/releases/download/v${name}/localdot-${name}-${TARGET}.tgz`,
          },
        },
        images: { arm64: images, x64: images },
      }),
    );
    return JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
    });
  };
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/channels/")) return res.end(signed());
    const range = req.headers.range;
    flow.catalog.ranges.push(range);
    const from = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
    if (from) {
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${from}-${archive.length - 1}/${archive.length}`);
    }
    res.setHeader("content-length", archive.length - from);
    const until =
      flow.catalog.drops > 0 && flow.catalog.dropAt > from ? flow.catalog.dropAt : archive.length;
    if (until < archive.length) flow.catalog.drops--;
    if (flow.catalog.stall && from + 1024 < archive.length) {
      res.write(archive.subarray(from, from + 1024));
      return;
    }
    res.write(archive.subarray(from, until), () => {
      if (until < archive.length) res.destroy();
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(catalogPort, "127.0.0.1", resolve));
  const docker = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const json = (value: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (path.endsWith("/version"))
      return json({
        Os: "linux",
        Arch: process.arch === "arm64" ? "arm64" : "amd64",
        Version: "29.0.0",
      });
    if (path.endsWith("/info")) return json({ ID: "fake", OperatingSystem: "Docker Desktop" });
    if (path.endsWith("/json")) {
      const reference = decodeURIComponent(/\/images\/(.+)\/json$/.exec(path)?.[1] ?? "");
      return json({
        Id: `sha256:${"e".repeat(64)}`,
        Os: "linux",
        Architecture: process.arch === "arm64" ? "arm64" : "amd64",
        RepoDigests: [reference],
      });
    }
    res.statusCode = 404;
    res.end();
  });
  const socket = join(root, "docker.sock");
  await new Promise<void>((resolve) => docker.listen(socket, resolve));
  writeFileSync(
    join(root, "fetch-shim.mjs"),
    `const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith("https://")) return real(input, init);
  const response = await real("http://127.0.0.1:${catalogPort}" + new URL(url).pathname, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
};`,
  );
  const shim = (name: string, body: string) =>
    writeFileSync(join(fake, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  shim(
    "launchctl",
    `FLOW_ROOT=${home} exec ${process.execPath} ${join(REPO, "scripts/distribution/testing/fake-launchd.mjs")} "$@"`,
  );
  shim("open", `echo "$*" >> ${join(root, "open.log")}`);
  shim("docker", 'case "$1 $2" in "info --format") echo 29.0.0 ;; "image inspect") exit 0 ;; esac');
  shim(
    "sleep",
    'exec /bin/sleep "$(/usr/bin/awk -v s="$1" \'BEGIN { print (s > 0.05 ? 0.05 : s) }\')"',
  );
  shim(
    "curl",
    `for a in "$@"; do case "$a" in https://downloads.localdot.dev/bootstrap/*) while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp ${join(bundle, "bootstrap.mjs")} "$out"; exit 0 ;; esac; done
exec /usr/bin/curl "$@"`,
  );
  const nodeDir = join(prefix, "runtime", `node-v${NODE_VERSION}-${TARGET}`, "bin");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, "node"),
    `#!/bin/bash
[ "$1" != --version ] || { echo v${NODE_VERSION}; exit 0; }
export NODE_OPTIONS=--import=${join(root, "fetch-shim.mjs")} DOCKER_HOST=unix://${socket}
exec ${process.execPath} "$@"
`,
    { mode: 0o755 },
  );
  const environment = { HOME: home, PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin` };
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    docker.close();
    for (const service of SERVICES)
      await run(join(fake, "launchctl"), ["bootout", `gui/501/${service}`], {
        env: environment,
      }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(root, { recursive: true, force: true });
  });
  await run(
    "/bin/bash",
    [
      join(bundle, "install.sh"),
      "--prefix",
      prefix,
      "--home",
      data,
      "--port",
      String(port),
      "--yes",
      "--no-prerequisites",
    ],
    {
      env: environment,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok, 20_000);
  const stages: string[] = [];
  const statusOf = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/app-update?v=2`, {
      signal: AbortSignal.timeout(2000),
    });
    const status = (await response.json()) as Awaited<ReturnType<Flow["status"]>>;
    const progress = status.progress as { step?: string; detail?: string } | null;
    const line = `${status.phase}/${progress?.step ?? "-"}/${status.currentVersion}`;
    if (stages.at(-1) !== line) stages.push(line);
    return status;
  };
  return {
    root,
    port,
    get version() {
      return flow.version;
    },
    set version(value: number) {
      flow.version = value;
    },
    catalog: flow.catalog,
    control: (name, value) => writeFileSync(join(home, "control", name), value),
    clear: (name) => rmSync(join(home, "control", name), { force: true }),
    status: statusOf,
    post: async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/app-update/${path}`, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, text: await response.text() };
    },
    stages,
    reached: async (check, ms = 60_000) => {
      let last: Awaited<ReturnType<Flow["status"]>> | undefined;
      await waitFor(async () => {
        try {
          last = await statusOf();
        } catch {
          stages.push("down");
          return false;
        }
        return check(last);
      }, ms);
      return last as Awaited<ReturnType<Flow["status"]>>;
    },
    log: (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""),
    running: () =>
      JSON.parse(readFileSync(join(prefix, "app/package-release.json"), "utf8")).version,
  };
}
async function waitFor(check: () => Promise<boolean>, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > until) throw new Error("Timed out waiting for the update.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const CONFIRM = { confirmShutdown: true };

describe.skipIf(process.platform !== "darwin")("the in-app update, installed", () => {
  it("goes from one click to the new version running, in stages, with no browser opened", async () => {
    const f = await installation();
    f.version = 91;
    expect((await f.post("update", CONFIRM)).status).toBe(202);
    const done = await f.reached(
      (status) => status.currentVersion === version(91) && status.phase === "idle",
    );
    expect(done).toMatchObject({ error: null, updating: false, availableVersion: null });
    expect(f.running()).toBe(version(91));
    expect(
      f.stages.some((line) => line.startsWith("downloading/") || line.startsWith("checking/")),
    ).toBe(true);
    expect(f.log("open.log").split("\n").filter(Boolean)).toHaveLength(1);
    const launchctl = readFileSync(join(f.root, "h/launchctl.log"), "utf8");
    expect(launchctl.match(/bootstrap .*keyd/g)).toHaveLength(1);
    expect(readdirSync(join(f.root, "p"))).not.toContain(".package-swap");
    await waitFor(
      async () =>
        !existsSync(join(f.root, "d/prepared-package-update.json")) ||
        JSON.parse(readFileSync(join(f.root, "d/prepared-package-update.json"), "utf8")) === null,
      5000,
    );
  }, 120_000);

  it("follows the channel past a download a newer release has overtaken", async () => {
    const f = await installation();
    f.version = 91;
    await f.post("check");
    await f.reached((status) => status.phase === "ready");
    f.version = 92;
    await f.post("update", CONFIRM);
    await f.reached((status) => status.currentVersion === version(92) && status.phase === "idle");
    expect(f.running()).toBe(version(92));
  }, 120_000);

  it("rolls back when the new version's checks fail, says so, and a retry then works", async () => {
    const f = await installation();
    f.version = 91;
    await f.post("check");
    await f.reached((status) => status.phase === "ready");
    f.control("doctor-exit", "1");
    await f.post("update", CONFIRM);
    const failed = await f.reached(
      (status) =>
        status.currentVersion === version(90) && !!status.error && status.phase === "ready",
    );
    expect(failed.error).toBe(
      `localDot ${version(91)} started but failed its checks, so your previous version was restored.`,
    );
    expect(f.running()).toBe(version(90));
    f.clear("doctor-exit");
    await f.post("update", CONFIRM);
    await f.reached((status) => status.currentVersion === version(91) && status.phase === "idle");
    expect(f.running()).toBe(version(91));
  }, 120_000);

  it("rolls back a new version that crashes on start, with the old one running", async () => {
    const f = await installation();
    f.version = 91;
    f.control("crash-version", version(91));
    await f.post("update", CONFIRM);
    const failed = await f.reached(
      (status) => status.currentVersion === version(90) && !!status.error,
      90_000,
    );
    expect(failed.error).toContain("didn't start, so your previous version was restored.");
    expect(f.running()).toBe(version(90));
    expect(f.stages).toContain("down");
  }, 150_000);

  it("resumes a dropped download instead of starting over", async () => {
    const f = await installation();
    f.version = 91;
    f.catalog.dropAt = 3 * 1024 * 1024;
    f.catalog.drops = 1;
    f.catalog.ranges.length = 0;
    await f.post("update", CONFIRM);
    await f.reached((status) => status.currentVersion === version(91) && status.phase === "idle");
    expect(f.catalog.ranges[0]).toBeUndefined();
    expect(f.catalog.ranges[1]).toMatch(/^bytes=\d+-$/);
    expect(f.catalog.ranges).toHaveLength(2);
  }, 120_000);

  it("a working task holds the update back in words, and nothing is stopped", async () => {
    const f = await installation();
    f.version = 91;
    f.control("busy", "Finish or stop the task before updating localDot.");
    const services = readFileSync(join(f.root, "h/launchctl.log"), "utf8");
    // Asked for, the update gets ready and waits for the task; it is not refused.
    expect((await f.post("update", CONFIRM)).status).toBe(202);
    await f.reached(
      (status) =>
        status.phase === "ready" &&
        status.updating &&
        status.waiting === "Finish or stop the task before updating localDot.",
    );
    expect(f.running()).toBe(version(90));
    expect(readFileSync(join(f.root, "h/launchctl.log"), "utf8")).toBe(services);
    // Called off, it stays downloaded and nothing is under way.
    expect((await f.post("cancel", {})).status).toBe(200);
    await f.reached((status) => status.phase === "ready" && !status.updating && !status.waiting);
    expect(f.running()).toBe(version(90));
  }, 120_000);

  it("takes a second click and a second device as the same update", async () => {
    const f = await installation();
    f.version = 91;
    f.catalog.ranges.length = 0;
    const answers = await Promise.all([
      f.post("update", CONFIRM),
      f.post("update", CONFIRM),
      f.post("install", CONFIRM),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([202, 202, 202]);
    await f.reached(
      (status) => status.phase === "installing" || status.currentVersion === version(91),
    );
    await f.post("update", CONFIRM).catch(() => {});
    await f.reached((status) => status.currentVersion === version(91) && status.phase === "idle");
    expect(f.catalog.ranges).toHaveLength(1);
    expect(
      readFileSync(join(f.root, "d/logs/package-update.log"), "utf8").match(
        /Using the app package downloaded earlier/g,
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("puts the old version back when the installer is killed in the middle of the swap", async () => {
    const f = await installation();
    f.version = 91;
    await f.post("check");
    await f.reached((status) => status.phase === "ready");
    const killedInTheSwap = async () => {
      const status = join(f.root, "d/app-update-install.json");
      if (!existsSync(status)) return false;
      const { stage, pid } = JSON.parse(readFileSync(status, "utf8"));
      if (stage !== "stop" && stage !== "start") return false;
      process.kill(pid, "SIGKILL");
      return true;
    };
    await f.post("update", CONFIRM);
    await waitFor(killedInTheSwap, 30_000);
    const failed = await f.reached(
      (status) => status.currentVersion === version(90) && !!status.error,
      60_000,
    );
    expect(failed.error).toBe(
      `The update to localDot ${version(91)} was interrupted, so your previous version was restored.`,
    );
    expect(f.running()).toBe(version(90));
    expect(existsSync(join(f.root, "p/.package-swap"))).toBe(false);
  }, 150_000);
});
