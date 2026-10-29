import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { RULES } from "../../../scripts/check-hygiene.mjs";
import { PACK_RULES } from "../../../scripts/check-pack.mjs";
import { buildCli } from "./build.mjs";
import { WORKSPACE } from "./build-options.mjs";
import { DIAGNOSTIC_ASSETS } from "./diagnostic-assets.mjs";

let root, output;
const children = new Set(),
  servers = new Set();
const token = "t".repeat(43),
  code = "c".repeat(43);
const cell = "01JXYZ00000000000000000001",
  session = "01JXYZ00000000000000000002";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "localdot-cli-process-")));
  output = await buildCli({ output: join(root, "output with space"), version: "1.2.3-rc.2" });
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  children.clear();
  for (const server of servers) {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
  servers.clear();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function home() {
  const path = await mkdtemp(join(root, "home-"));
  await writeFile(join(path, "daemon-token"), token, { mode: 0o600 });
  return path;
}
async function daemon(handler) {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}
function cli(args, extra = {}) {
  const child = spawn(process.execPath, [join(output, "bin/localdot.mjs"), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, LOCALDOT_HOME: join(root, "uninstalled"), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const done = once(child, "close").then(([status, signal]) => ({
    status,
    signal,
    stdout,
    stderr,
  }));
  return { child, done };
}

it("builds a self-contained CLI with an executable launcher and no unpublished paths or constants", async () => {
  expect((await stat(join(output, "bin/localdot.mjs"))).mode & 0o100).not.toBe(0);
  expect(await readdir(join(output, "dist"))).toEqual([
    "canary-scan.py",
    "canary-worker.py",
    "cli.mjs",
    "release-verification-worker.mjs",
  ]);
  for (const [source, target] of Object.entries(DIAGNOSTIC_ASSETS))
    expect(await readFile(join(output, target))).toEqual(await readFile(join(WORKSPACE, source)));
  for (const relative of [
    ...Object.values(DIAGNOSTIC_ASSETS),
    "bin/localdot.mjs",
    "dist/cli.mjs",
    "dist/release-verification-worker.mjs",
  ]) {
    const text = await readFile(join(output, relative), "utf8");
    for (const { name, pattern } of [...RULES, ...PACK_RULES])
      expect(pattern.test(text), name).toBe(false);
  }
  const result = await cli(["--version"]).done;
  expect(result).toEqual({ status: 0, signal: null, stdout: "1.2.3-rc.2\n", stderr: "" });
});
it("runs help from a directory outside the repository without creating an installation", async () => {
  const before = await readdir(root);
  const result = await cli(["--help"], { LOCALDOT_PORT: "invalid" }).done;
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("localdot open");
  expect(await readdir(root)).toEqual(before);
});
it("rejects pasted credentials and missing installation state without printing them", async () => {
  const bad = await cli(["open", "--token", token]).done;
  expect(bad.status).toBe(2);
  expect(bad.stdout + bad.stderr).not.toContain(token);
  const missing = await cli(["open"]).done;
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("Could not create");
});
it("compiled reset explains erasure without an installation and refuses an unconfigured confirmed reset", async () => {
  const before = await readdir(root);
  const preview = await cli(["reset-computer", "--cell", cell], { LOCALDOT_PORT: "invalid" }).done;
  expect(preview.status).toBe(0);
  expect(preview.stdout).toContain("--erase-computer");
  expect(preview.stdout).toContain("Shared host files");
  expect(preview.stderr).toBe("");
  const confirmed = await cli(["reset-computer", "--cell", cell, "--erase-computer"]).done;
  expect(confirmed.status).toBe(1);
  expect(confirmed.stdout).toBe("");
  expect(confirmed.stderr).toContain("Reset could not start");
  expect(await readdir(root)).toEqual(before);
});
// Neither an installation's journal nor launchd/systemd services run this home.
it.each(["down", "up", "restart"])(
  "compiled %s refuses a home nothing manages, without creating state or downloading",
  async (command) => {
    const unmanaged = await mkdtemp(join(root, `unmanaged-${command}-`));
    const result = await cli([command], {
      LOCALDOT_HOME: unmanaged,
      LOCALDOT_PORT: String(await freePort()),
    }).done;
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("aren't set up on this computer");
    expect(result.stderr).toContain("rerun the localDot installer");
    expect(await readdir(unmanaged)).toEqual([]);
  },
);
it("compiled down refuses an invalid port for a home nothing manages", async () => {
  const unmanaged = await mkdtemp(join(root, "unmanaged-port-"));
  const result = await cli(["down"], { LOCALDOT_HOME: unmanaged, LOCALDOT_PORT: "invalid" }).done;
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("invalid");
  expect(await readdir(unmanaged)).toEqual([]);
});
it("compiled update refuses an unmanaged home before registry access or directory creation", async () => {
  const unmanaged = await realpath(await mkdtemp(join(root, "unmanaged-update-")));
  const result = await cli(["update"], {
    LOCALDOT_HOME: unmanaged,
    LOCALDOT_PORT: "invalid",
    DOCKER_HOST: "unrelated",
  }).done;
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("not installed");
  expect(await readdir(unmanaged)).toEqual([]);
});
it("compiled default explains missing prerequisites without creating an installation", async () => {
  const before = await readdir(root);
  const result = await cli([], { DOCKER_HOST: `unix://${join(root, "missing-docker.sock")}` }).done;
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Checking this Mac");
  expect(result.stdout).not.toContain("localDot is ready");
  expect(result.stderr).not.toBe("");
  expect(await readdir(root)).toEqual(before);
  await expect(stat(join(root, "uninstalled"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("compiled logs reads only managed private logs with invalid ambient port and stops following on SIGINT", async () => {
  const directory = await realpath(await mkdtemp(join(root, "logs-home-")));
  const state = join(directory, "install"),
    logs = join(state, "logs");
  await mkdir(state, { mode: 0o700 });
  await mkdir(logs, { mode: 0o700 });
  await writeFile(
    join(state, "service-owner.json"),
    JSON.stringify({ v: 1, id: "a".repeat(32), home: directory, state, uid: process.getuid() }),
    { mode: 0o600 },
  );
  for (const name of ["daemon.log", "daemon.error.log", "keyd.log", "keyd.error.log"])
    await writeFile(
      join(logs, name),
      name === "daemon.log" ? "startup fixture\nauthorization=Bearer private-fixture\n" : "",
      { mode: 0o600 },
    );
  const env = { LOCALDOT_HOME: directory, LOCALDOT_PORT: "invalid", DOCKER_HOST: "unrelated" };
  const snapshot = await cli(["logs"], env).done;
  expect(snapshot.status).toBe(0);
  expect(snapshot.stdout).toContain("[daemon.log] startup fixture");
  expect(snapshot.stdout).not.toContain("private-fixture");
  expect(snapshot.stderr).toBe("");
  const following = cli(["logs", "--follow"], env);
  await once(following.child.stdout, "data");
  following.child.kill("SIGINT");
  const result = await following.done;
  expect(result.status).toBe(130);
  expect(result.stderr).toBe("");
  expect(await readFile(join(logs, "daemon.log"), "utf8")).toContain("private-fixture");
});
it("uses one authenticated request and prints only the fresh one-use URL", async () => {
  const requests = [];
  const port = await daemon((req, res) => {
    requests.push({ url: req.url, method: req.method, token: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code, expiresAt: Date.now() + 30_000 }));
  });
  const result = await cli(["open"], { LOCALDOT_HOME: await home(), LOCALDOT_PORT: String(port) })
    .done;
  expect(result).toEqual({
    status: 0,
    signal: null,
    stdout: `http://127.0.0.1:${port}/#code=${code}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { url: "/api/install-code", method: "POST", token: `Bearer ${token}` },
  ]);
  expect(result.stdout + result.stderr).not.toContain(token);
});
it("does not issue a sign-in request or expose a malformed stored credential", async () => {
  let requests = 0;
  const port = await daemon((_req, res) => {
    requests++;
    res.end("{}");
  });
  const directory = await home(),
    malformed = `localdot-test-token-${"t".repeat(45)}`;
  await writeFile(join(directory, "daemon-token"), malformed, { mode: 0o600 });
  const result = await cli(["open"], { LOCALDOT_HOME: directory, LOCALDOT_PORT: String(port) })
    .done;
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(malformed);
  expect(requests).toBe(0);
});
it("does not follow a sign-in redirect or retry a lost response", async () => {
  for (const kind of ["redirect", "lost"]) {
    let requests = 0;
    const port = await daemon((_req, res) => {
      requests++;
      if (kind === "lost") res.destroy();
      else {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/unexpected` });
        res.end();
      }
    });
    const result = await cli(["open"], { LOCALDOT_HOME: await home(), LOCALDOT_PORT: String(port) })
      .done;
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(requests).toBe(1);
  }
});
it("SIGINT cancels a stalled sign-in response without another issuance", async () => {
  let received;
  const ready = new Promise((resolve) => {
    received = resolve;
  });
  let requests = 0;
  const port = await daemon((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"code":"');
    received();
  });
  const running = cli(["open"], { LOCALDOT_HOME: await home(), LOCALDOT_PORT: String(port) });
  await ready;
  running.child.kill("SIGINT");
  const result = await running.done;
  expect(result.status).toBe(130);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("interrupted");
  expect(requests).toBe(1);
});
it("the compiled Stop command requires explicit containment facts from the selected live session", async () => {
  for (const confirmed of [true, false]) {
    const requests = [];
    const port = await daemon((req, res) => {
      requests.push([req.method, req.url, req.headers.authorization]);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/cells") {
        res.end(
          JSON.stringify([
            {
              id: cell,
              state: "ready",
              scale: 1,
              createdAt: "fixture",
              stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
            },
          ]),
        );
      } else if (req.url === `/api/cells/${cell}/live`)
        res.end(JSON.stringify({ sessionId: session }));
      else if (req.url === `/api/sessions/${session}/stop` && req.method === "POST") {
        res.statusCode = 202;
        res.end(
          JSON.stringify({
            revoked: confirmed,
            paused: confirmed,
            closed: false,
            stopped: false,
            errors: [],
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    const result = await cli(["stop", "--cell", cell], {
      LOCALDOT_HOME: await home(),
      LOCALDOT_PORT: String(port),
    }).done;
    expect(result.status).toBe(confirmed ? 0 : 1);
    expect(confirmed ? result.stdout : result.stderr).toContain(
      confirmed ? "Stop confirmed" : "Stop is unconfirmed",
    );
    expect(requests).toEqual([
      ["GET", "/api/cells", `Bearer ${token}`],
      ["GET", `/api/cells/${cell}/live`, `Bearer ${token}`],
      ["POST", `/api/sessions/${session}/stop`, `Bearer ${token}`],
    ]);
    expect(result.stdout + result.stderr).not.toContain(token);
  }
});
it("requires a concrete release version before producing output", async () => {
  const out = join(root, "invalid-version");
  await expect(buildCli({ output: out, version: "../bad" })).rejects.toThrow("release version");
  expect(await readdir(root)).not.toContain("invalid-version");
});
