import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sampleManifest } from "../../../packages/protocol/src/testing/sample-release.ts";
import { checkPackArchive } from "../../../scripts/check-pack-archive.mjs";
import { verifyStagedRelease } from "../src/install/staged-release.ts";
import { buildAppPackage } from "./build-app-package.mjs";
import { packAppRelease } from "./pack-app-release.mjs";
import { writeRuntimeDependencies } from "./runtime-dependencies.mjs";

const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-app-package-")));
  roots.push(root);
  const source = join(root, "runtime");
  await mkdir(source, { mode: 0o700 });
  await writeRuntimeDependencies({ output: source, version: "1.0.0" });
  const data = {
    "bin/localdot.mjs": "#!/usr/bin/env node\nexport {};\n",
    "dist/cli.mjs": "export {};\n",
    "dist/daemon.mjs": "export {};\n",
    "dist/release-verification-worker.mjs": "export {};\n",
    "dist/browser-seccomp.json": "{}\n",
    "dist/canary-scan.py": "# fixture\n",
    "dist/canary-worker.py": "# fixture\n",
    "dist/sandbox-runtime/package.json": "{}\n",
    "dist/sandbox-runtime/LICENSE": "Apache-2.0\n",
    "dist/sandbox-runtime/NOTICE.md": "# Fixture sandbox\n",
    "dist/sandbox-runtime/PATCH.txt": "fixture\n",
    "dist/sandbox-runtime/dist/cli.mjs": "export {};\n",
    "dist/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar": "fixture jar\n",
    "skills/office-files/SKILL.md": "# Fixture office files\n",
    "web/dist/index.html": "<!doctype html>\n",
    "web/dist/export.html": "<!doctype html>\n",
    "web/dist/assets/index.js": "export {};\n",
    "web/dist/assets/licenses/mediabunny-1.61.0.txt": "MPL-2.0\n",
    "web/vendor/selkies/LICENSE": "MPL-2.0\n",
    "web/vendor/selkies/NOTICE.md": "# Fixture Selkies\n",
  };
  for (const [path, text] of Object.entries(data)) {
    await mkdir(dirname(join(source, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, path), text, {
      mode: path === "bin/localdot.mjs" ? 0o700 : 0o600,
    });
  }
  const files = [];
  for (const path of [...Object.keys(data), "package.json", "npm-shrinkwrap.json"]) {
    const bytes = await readFile(join(source, path));
    files.push({ path, size: bytes.length, sha256: hash(bytes) });
  }
  const keydBinary = join(root, "fake-keyd");
  await writeFile(keydBinary, "fake signed-helper seam", { mode: 0o700 });
  const input = {
    output: join(root, "app"),
    runtimeDirectory: source,
    keydBinary,
    runtimeReceipt: {
      output: source,
      version: "1.0.0",
      files,
      sandbox: { upstreamArchiveVerified: true },
    },
    commit: "a".repeat(40),
    images: sampleManifest().images,
  };
  return { root, source, input, verify: vi.fn(async () => {}) };
}

async function archiveFixture() {
  const f = await fixture();
  const inputFile = join(f.root, "inputs.json"),
    output = join(f.root, "release");
  await writeFile(join(f.root, "runtime.json"), JSON.stringify(f.input.runtimeReceipt));
  const config = {
    runtimeDirectory: "runtime",
    runtimeReceipt: "runtime.json",
    keydBinary: "fake-keyd",
    commit: f.input.commit,
    images: f.input.images,
  };
  await writeFile(inputFile, JSON.stringify(config));
  return { ...f, inputFile, output, config };
}

it("the archive command packs actual bytes with isolated npm configuration and a final receipt outside the payload", async () => {
  const f = await archiveFixture();
  // These inherited options would break packing, enable a dry run or run injected Node code.
  vi.stubEnv("NODE_OPTIONS", "--require=/nonexistent-localdot-test-injection.cjs");
  vi.stubEnv("npm_config_dry_run", "true");
  vi.stubEnv("npm_config_userconfig", "/nonexistent-localdot-user-config");
  const { result, receipt } = await packAppRelease(f, (input) => buildAppPackage(input, f.verify));
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(await readdir(f.output)).toEqual(["app", "artifacts", "receipt.json"]);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(result);
  expect(result.archiveAllFileHashesVerified).toBe(true);
  expect(result.sourceCommitVerified).toBe(false);
  expect(result.completeRelease).toBe(false);
  expect(result.published).toBe(false);
  expect(result.inputSHA256).toBe(hash(await readFile(f.inputFile)));
  expect(result.archive.sha256).toBe(hash(await readFile(result.archive.path)));
  expect(result.archive.files.map((file) => file.path)).not.toContain("receipt.json");
  expect(result.archive.files.length).toBe(result.files.length);
}, 45000);

it.each(["changed", "omitted"])(
  "the archive command refuses %s packed bytes and produces no success receipt",
  async (kind) => {
    const f = await archiveFixture();
    await expect(
      packAppRelease(f, async (input) => {
        const result = await buildAppPackage(input, f.verify);
        const path = join(result.output, "dist/cli.mjs");
        if (kind === "changed") await writeFile(path, "export const changed = true;\n");
        else await rm(path);
        return result;
      }),
    ).rejects.toThrow("verification");
    expect(await readdir(f.output)).not.toContain("receipt.json");
    expect(await readdir(f.output)).not.toContain("work");
  },
  45000,
);

it("the archive command refuses production signature failure without emitting a tarball or success receipt", async () => {
  const f = await archiveFixture();
  await expect(packAppRelease(f)).rejects.toThrow("release verification");
  expect(await readdir(f.output)).toEqual([]);
});

it("the archive command preserves an existing destination and never starts the builder", async () => {
  const f = await archiveFixture(),
    build = vi.fn();
  await mkdir(f.output);
  await writeFile(join(f.output, "receipt.json"), "preserve existing artifact");
  await expect(packAppRelease(f, build)).rejects.toThrow();
  expect(build).not.toHaveBeenCalled();
  expect(await readFile(join(f.output, "receipt.json"), "utf8")).toBe("preserve existing artifact");
});

it.each([
  "unknown-field",
  "invalid-path",
  "invalid-json",
  "linked-input",
  "large-input",
  "large-receipt",
])("the archive command refuses %s before creating output", async (kind) => {
  const f = await archiveFixture(),
    build = vi.fn();
  if (kind === "unknown-field") f.config.signingIdentity = "caller-chosen";
  if (kind === "invalid-path") f.config.runtimeReceipt = 123;
  await writeFile(f.inputFile, JSON.stringify(f.config));
  if (kind === "invalid-json") await writeFile(f.inputFile, "{");
  if (kind === "linked-input") {
    await writeFile(join(f.root, "target.json"), JSON.stringify(f.config));
    await rm(f.inputFile);
    await symlink(join(f.root, "target.json"), f.inputFile);
  }
  if (kind === "large-input") await writeFile(f.inputFile, " ".repeat(64 * 1024 + 1));
  if (kind === "large-receipt")
    await writeFile(join(f.root, "runtime.json"), " ".repeat(8 * 1024 * 1024 + 1));
  await expect(packAppRelease(f, build)).rejects.toThrow();
  expect(build).not.toHaveBeenCalled();
  expect(await readdir(f.root)).not.toContain("release");
});

it("the actual command rejects extra arguments and redacts invalid input details", async () => {
  const f = await archiveFixture();
  const script = new URL("./pack-app-release.mjs", import.meta.url);
  const invoke = (args) => {
    try {
      execFileSync(process.execPath, ["--experimental-transform-types", script.pathname, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
      });
      throw new Error("expected refusal");
    } catch (error) {
      return error;
    }
  };
  const extra = invoke([f.inputFile, f.output, "extra"]);
  expect(extra.status).toBe(2);
  expect(extra.stderr).toContain("Usage:");
  await writeFile(f.inputFile, "sensitive-invalid-test-value");
  const invalid = invoke([f.inputFile, f.output]);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toBe(
    "App archive build failed. Partial output is not a verified release.\n",
  );
  expect(await readdir(f.root)).not.toContain("release");
});

it("produces a complete hashed app package accepted by the installer and actual offline npm archive audit", async () => {
  const f = await fixture(),
    result = await buildAppPackage(f.input, f.verify);
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    appMetadataBuilt: true,
    signatureVerified: true,
    completeRelease: false,
    releaseProvenanceVerified: false,
    imageAvailabilityVerified: false,
    published: false,
  });
  const manifest = JSON.parse(await readFile(join(result.output, "release.json"), "utf8"));
  expect(manifest.keyd.teamId).toBe("87FD3FSZBG");
  expect(manifest.files["package.json"]).toBeUndefined();
  expect(manifest.files["release.json"]).toBeUndefined();
  expect(Object.keys(manifest.files).length).toBe(result.files.length - 2);
  const pkg = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
  expect(pkg.private).toBeUndefined();
  expect(pkg.scripts).toBeUndefined();
  expect(await readFile(join(result.output, "npm-shrinkwrap.json"))).toEqual(
    await readFile(join(f.source, "npm-shrinkwrap.json")),
  );
  expect(
    (await verifyStagedRelease(result.output, result.metadataDigests, new AbortController().signal))
      .files,
  ).toBe(result.files.length);
  const out = join(f.root, "tarballs");
  await mkdir(out);
  const home = join(f.root, "isolated-home");
  await mkdir(home);
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", out],
      {
        cwd: result.output,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          npm_config_cache: join(f.root, "cache"),
          npm_config_userconfig: join(f.root, "empty-user-npmrc"),
          npm_config_globalconfig: join(f.root, "empty-global-npmrc"),
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    ),
  );
  const audit = checkPackArchive(join(out, packed.filename), { temporaryParent: f.root });
  expect(audit.problems).toEqual([]);
  expect(audit.integrity).toBe(packed.integrity);
  expect(Object.fromEntries(audit.files.map((file) => [file.path, file.sha256]))).toEqual(
    Object.fromEntries(result.files.map((file) => [file.path, file.sha256])),
  );
  expect(audit.files.find((file) => file.path === "bin/localdot.mjs").mode & 0o100).toBeTruthy();
}, 45000);

it.each([
  "modified",
  "missing",
  "extra",
  "duplicate",
  "case-collision",
  "symlink",
  "hardlink",
  "oversized-receipt",
  "unsafe-mode",
])("refuses %s runtime inputs before writing output", async (kind) => {
  const f = await fixture(),
    path = join(f.source, "dist/cli.mjs");
  if (kind === "modified") await writeFile(path, "changed");
  if (kind === "missing") await rm(path);
  if (kind === "extra") await writeFile(join(f.source, "private.txt"), "extra");
  if (kind === "duplicate")
    f.input.runtimeReceipt.files.push({ ...f.input.runtimeReceipt.files[0] });
  if (kind === "case-collision") await writeFile(join(f.source, "dist/CLI.mjs"), "collision");
  if (kind === "symlink") {
    await rm(path);
    await symlink(f.input.keydBinary, path);
  }
  if (kind === "hardlink") {
    await rm(path);
    await link(f.input.keydBinary, path);
  }
  if (kind === "oversized-receipt") f.input.runtimeReceipt.files[0].size = 17 * 1024 * 1024;
  if (kind === "unsafe-mode") await chmod(path, 0o666);
  await expect(buildAppPackage(f.input, f.verify)).rejects.toThrow();
  expect(f.verify).not.toHaveBeenCalled();
  expect(await readdir(f.root)).not.toContain("app");
});

it.each([
  "unverified-upstream",
  "wrong-version",
  "bad-commit",
  "tagged-image",
  "role-swap",
  "lock-mismatch",
  "signature",
])("refuses %s build metadata", async (kind) => {
  const f = await fixture();
  if (kind === "unverified-upstream")
    f.input.runtimeReceipt.sandbox.upstreamArchiveVerified = false;
  if (kind === "wrong-version") f.input.runtimeReceipt.version = "2.0.0";
  if (kind === "bad-commit") f.input.commit = "HEAD";
  if (kind === "tagged-image") f.input.images.browser.digest = "latest";
  if (kind === "role-swap") f.input.images.browser.repository = f.input.images.desktop.repository;
  if (kind === "signature") f.verify.mockRejectedValue(new Error("signature rejected"));
  if (kind === "lock-mismatch") {
    const path = "npm-shrinkwrap.json",
      bytes = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    await writeFile(join(f.source, path), bytes);
    Object.assign(
      f.input.runtimeReceipt.files.find((file) => file.path === path),
      { size: bytes.length, sha256: hash(bytes) },
    );
  }
  await expect(buildAppPackage(f.input, f.verify)).rejects.toThrow();
  expect(await readdir(f.root)).not.toContain("app");
});

it("does not alter an existing destination", async () => {
  const f = await fixture();
  await mkdir(f.input.output);
  await writeFile(join(f.input.output, "keep"), "user file");
  await expect(buildAppPackage(f.input, f.verify)).rejects.toThrow();
  expect(await readdir(f.input.output)).toEqual(["keep"]);
  expect(await readFile(join(f.input.output, "keep"), "utf8")).toBe("user file");
});

it("rechecks the signed helper after assembly and refuses a changed helper", async () => {
  const f = await fixture();
  f.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("changed helper"));
  await expect(buildAppPackage(f.input, f.verify)).rejects.toThrow("changed helper");
});

it("the default verifier refuses a fake helper instead of accepting an injected receipt", async () => {
  const f = await fixture();
  await expect(buildAppPackage(f.input)).rejects.toThrow("release verification");
  expect(await readdir(f.root)).not.toContain("app");
});
