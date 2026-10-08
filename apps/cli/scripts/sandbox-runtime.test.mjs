import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import {
  buildSandbox,
  checkSandboxPatch,
  installedSandboxRoot,
  JAVA_AGENT,
  SANDBOX_DIRECTORY,
  SANDBOX_ENTRY,
} from "./sandbox-runtime.mjs";

let root, payload, receipt;
const version = "0.0.0-rc.0";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "localdot-packaged-sandbox-"));
  const initial = join(root, "build");
  await mkdir(initial);
  receipt = await buildSandbox({ output: initial, version });
  const original = installedSandboxRoot();
  const source = (path) => JSON.stringify(join(original, path));
  await build({
    ...runtimeBuildOptions(version),
    stdin: {
      contents: `
import {srtCli} from ${JSON.stringify(join(WORKSPACE, "harness/codex/src/args.ts"))};
console.log(srtCli());`,
      resolveDir: WORKSPACE,
    },
    outfile: join(initial, "dist/resolve-probe.mjs"),
  });
  await build({
    ...runtimeBuildOptions(version),
    stdin: {
      contents: `
import {wrapCommandWithSandboxMacOS as wrap} from ${source("dist/sandbox/macos-sandbox-utils.js")};
import {getJavaProxyAgentJarPathAsync as jar} from ${source("dist/sandbox/java-proxy-agent.js")};
const options = {command:'/usr/bin/true',needsNetworkRestriction:true,readConfig:{denyOnly:[],allowWithinDeny:[]},writeConfig:{allowOnly:[],denyWithinAllow:[]},allowLocalBinding:false,loopbackBindPorts:[1455],binShell:'/bin/sh',httpProxyPort:19877,socksProxyPort:19878};
const command = wrap(options);
const refused = [{allowLocalBinding:true},{allowAllUnixSockets:true},{needsNetworkRestriction:false},{enableWeakerNetworkIsolation:true},{loopbackBindPorts:[0]},{loopbackBindPorts:[65536]}].map(change=>{try {wrap({...options,...change});return false;}catch{return true;}});
console.log(JSON.stringify({command,refused,jar:await jar()}));`,
      resolveDir: WORKSPACE,
    },
    outfile: join(initial, SANDBOX_DIRECTORY, "dist/policy-probe.mjs"),
  });
  const destination = join(root, "installed app's #directory%value");
  await rename(initial, destination);
  payload = await realpath(destination);
}, 30_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
function run(file, args = []) {
  return spawnSync(process.execPath, [join(payload, file), ...args], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root },
    encoding: "utf8",
    timeout: 10_000,
  });
}

it("runs the relocated CLI help and its own pinned version without workspace dependencies", async () => {
  const help = run(SANDBOX_ENTRY, ["--help"]),
    version = run(SANDBOX_ENTRY, ["--version"]);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("Run commands in a sandbox");
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout.trim()).toBe("0.0.78");
  expect(receipt.patchCheck.hunks).toBeGreaterThan(0);
  expect(Object.keys(receipt.patchCheck.files)).toHaveLength(7);
  // Patch presence and local execution never stand in for upstream archive verification.
  expect(receipt.upstreamArchiveVerified).toBe(false);
});

it("keeps exact callback/proxy policy and resolves the bundled Java agent without launching either", async () => {
  const result = run(`${SANDBOX_DIRECTORY}/dist/policy-probe.mjs`);
  expect(result.status, result.stderr).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.command).toContain('(allow network-bind (local ip "localhost:1455"))');
  expect(value.command).toContain('(allow network-inbound (local ip "localhost:1455"))');
  for (const port of [19877, 19878]) expect(value.command).toContain(`localhost:${port}`);
  for (const broad of ['"localhost:*"', '"*:*"', "(allow network*)"])
    expect(value.command).not.toContain(broad);
  expect(value.refused).toEqual([true, true, true, true, true, true]);
  expect(value.jar).toBe(join(payload, SANDBOX_DIRECTORY, JAVA_AGENT));
  const jar = await readFile(value.jar);
  expect(createHash("sha256").update(jar).digest("hex")).toBe(receipt.javaAgentSHA256);
});

it("resolves only the packaged runtime and refuses a missing or linked CLI", async () => {
  const result = run("dist/resolve-probe.mjs");
  expect(result.status, result.stderr).toBe(0);
  const path = join(payload, SANDBOX_ENTRY);
  expect(result.stdout.trim()).toBe(path);
  const bytes = await readFile(path);
  await rm(path);
  try {
    expect(run("dist/resolve-probe.mjs").status).not.toBe(0);
    const outside = join(root, "other.mjs");
    await writeFile(outside, bytes);
    await symlink(outside, path);
    expect(run("dist/resolve-probe.mjs").status).not.toBe(0);
  } finally {
    await rm(path, { force: true });
    await writeFile(path, bytes);
  }
});

it("rejects a missing version manifest instead of reporting the app version", async () => {
  const path = join(payload, SANDBOX_DIRECTORY, "package.json"),
    bytes = await readFile(path);
  await rm(path);
  try {
    const result = run(SANDBOX_ENTRY, ["--version"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  } finally {
    await writeFile(path, bytes);
  }
});

it("checks the complete patch post-image and rejects changed or linked target files", async () => {
  const dir = join(root, "patch-input"),
    target = join(dir, "dist/example.js");
  await mkdir(dirname(target), { recursive: true });
  const patch = Buffer.from("+++ b/dist/example.js\n@@ -1 +1,2 @@\n-old\n+first\n+second\n");
  await writeFile(target, "first\nsecond\n");
  expect((await checkSandboxPatch(dir, patch)).hunks).toBe(1);
  await writeFile(target, "first\nwrong\n");
  await expect(checkSandboxPatch(dir, patch)).rejects.toThrow("exact local patch");
  await rm(target);
  await symlink(join(root, "other.mjs"), target);
  await expect(checkSandboxPatch(dir, patch)).rejects.toThrow("input file");
  await expect(checkSandboxPatch(dir, Buffer.from(""))).rejects.toThrow("Empty");
});

it("refuses a different dependency version and preserves an existing sandbox payload", async () => {
  const source = join(root, "wrong-source");
  await mkdir(source);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version: "0.0.1" }),
  );
  await expect(buildSandbox({ output: join(root, "invalid"), version, source })).rejects.toThrow(
    "version",
  );
  const before = await readFile(join(payload, SANDBOX_ENTRY));
  await expect(buildSandbox({ output: payload, version })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(join(payload, SANDBOX_ENTRY))).toEqual(before);
});
