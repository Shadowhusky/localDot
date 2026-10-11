import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../apps/cli/node_modules/esbuild/lib/main.js";
import { runtimeBuildOptions } from "../../apps/cli/scripts/build-options.mjs";
import { buildRuntime } from "../../apps/cli/scripts/build-runtime.mjs";
import { RULES } from "../check-hygiene.mjs";
import { PACK_RULES } from "../check-pack.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, stdio: "inherit", timeout: 15 * 60_000, ...options });
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
async function inventory(root, prefix = "") {
  const files = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name,
      full = join(root, path),
      stat = await lstat(full);
    if (stat.isSymbolicLink() || (stat.nlink > 1 && stat.isFile()))
      throw new Error(`Linked package member: ${path}`);
    if (stat.isDirectory()) Object.assign(files, await inventory(root, path));
    else if (stat.isFile()) {
      if (
        /\.(map|ts|tsx)$/.test(path) ||
        /(^|\/)(\.git|\.env[^/]*|src|test|tests)(\/|$)/.test(path)
      )
        throw new Error(`Source or development file in payload: ${path}`);
      const bytes = await readFile(full);
      for (const { name, pattern } of [...RULES, ...PACK_RULES]) {
        let text = bytes.toString("utf8");
        if (path.startsWith("node_modules/") && name === "developer path")
          text = text.replaceAll("/Users/runner/", "/upstream-ci/");
        // Go's crypto library contains PEM marker constants. A marker in a compiled binary
        // is not a credential; still reject a complete embedded private-key PEM block.
        const binary =
          path === "keyd" ||
          /\.(node|dylib|so|jar|icns)$/.test(path) ||
          path.endsWith("/localdot-notify");
        if (binary && name === "private key block") {
          const blocks = [
            ...text.matchAll(
              /-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}-----END [A-Z ]*PRIVATE KEY-----/g,
            ),
          ];
          // Public example CA compiled by pinned goproxy v1.9.2 (certs.go). localDot supplies
          // its own per-computer CA; this exact upstream constant is not a local credential.
          if (
            blocks.every(
              ([block]) =>
                path === "keyd" &&
                hash("sha256", block) ===
                  "1baeac79a6986396ba786d67029f862b71f0a15956527bcb2ae41a99906d806e",
            )
          )
            continue;
        }
        if (new RegExp(pattern.source, pattern.flags).test(text))
          throw new Error(`Package violates ${name}: ${path}`);
      }
      const mode = stat.mode & 0o111 ? 0o700 : 0o600;
      await chmod(full, mode);
      files[path] = { sha256: hash("sha256", bytes), bytes: bytes.length, mode };
    } else throw new Error(`Unsupported package member: ${path}`);
  }
  return files;
}
// Native dependencies are selected for the target; foreign Linux packages require a container smoke test before publishing.
export async function buildDistribution({
  output,
  version,
  publicKey,
  sandboxArchive,
  keydBinary,
  commit,
  target = `${process.platform}-${process.arch}`,
}) {
  if (
    !["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(target) ||
    !/^[a-f0-9]{40}$/.test(commit)
  )
    throw new Error("Unsupported release target or source revision.");
  if (target.startsWith("darwin-") && target !== `${process.platform}-${process.arch}`)
    throw new Error("Mac packages must be built on the matching Mac architecture.");
  const [os, cpu] = target.split("-");
  const out = resolve(output);
  await mkdir(out, { mode: 0o700 });
  const app = join(out, "app");
  const receipt = await buildRuntime({ output: app, version, sandboxArchive, target });
  if (!receipt.sandbox.upstreamArchiveVerified)
    throw new Error("Sandbox archive must verify before publication.");
  const bootstrap = join(out, "bootstrap.mjs");
  const options = runtimeBuildOptions(version);
  await build({
    ...options,
    entryPoints: [join(root, "scripts/distribution/bootstrap.ts")],
    outfile: bootstrap,
    define: {
      ...options.define,
      __LOCALDOT_DISTRIBUTION_KEY__: JSON.stringify(await readFile(publicKey, "utf8")),
    },
  });
  const bootstrapSHA256 = hash("sha256", await readFile(bootstrap));
  let installer = await readFile(join(root, "install.sh"), "utf8");
  installer = installer
    .replace(
      'DEFAULT_PACKAGE_CHANNEL=""',
      'DEFAULT_PACKAGE_CHANNEL="https://downloads.localdot.dev/channels/testing.json"',
    )
    .replace('PACKAGE_BOOTSTRAP_SHA256=""', `PACKAGE_BOOTSTRAP_SHA256="${bootstrapSHA256}"`);
  await writeFile(join(out, "install.sh"), installer, { mode: 0o700 });
  await writeFile(join(app, "install.sh"), installer, { mode: 0o700 });
  await copyFile(keydBinary, join(app, "keyd"));
  await chmod(join(app, "keyd"), 0o700);
  // All external dependency versions and hashes come from the generated shrinkwrap. End users
  // do not run npm, lifecycle hooks or native compilers. The isolated builder installs them here.
  const cache = join(out, "npm-cache");
  await writeFile(join(out, "user.npmrc"), "");
  await writeFile(join(out, "global.npmrc"), "");
  run(
    "npm",
    [
      "ci",
      // npm checks the root package against the build host even with --os/--cpu.
      // Override that builder-only check; target execution is a separate publication gate.
      ...(target !== `${process.platform}-${process.arch}` ? ["--force"] : []),
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-bin-links",
      `--os=${os}`,
      `--cpu=${cpu}`,
      ...(os === "linux" ? ["--libc=glibc"] : []),
      "--cache",
      cache,
    ],
    {
      cwd: app,
      env: {
        ...process.env,
        npm_config_userconfig: join(out, "user.npmrc"),
        npm_config_globalconfig: join(out, "global.npmrc"),
      },
    },
  );
  // Dependency packages contain development sources/types. Keep runtime entrypoints and licenses.
  async function clean(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name),
        st = await lstat(path);
      if (st.isSymbolicLink()) throw new Error("Unexpected runtime dependency link.");
      if (
        name === ".bin" ||
        ["src", "test", "tests"].includes(name) ||
        /\.(map|ts|tsx)$/.test(name)
      ) {
        const { rm } = await import("node:fs/promises");
        await rm(path, { recursive: true });
      } else if (st.isDirectory()) await clean(path);
    }
  }
  await clean(join(app, "node_modules"));
  if (target === `${process.platform}-${process.arch}`)
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();",
      ],
      { cwd: app },
    );
  await inventory(app);
  const filename = `localdot-${version}-${target}.tgz`;
  // npm packs regular files under package/ with one gzip member, matching the audited extractor.
  const metadata = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  metadata.files = ["bin", "dist", "web", "skills", "keyd", "install.sh", "npm-shrinkwrap.json"];
  metadata.bundleDependencies = Object.keys(metadata.dependencies);
  await writeFile(join(app, "package.json"), JSON.stringify(metadata));
  const finalFiles = await inventory(app);
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", out], {
      cwd: app,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }),
  )[0];
  const { rename } = await import("node:fs/promises");
  await rename(join(out, packed.filename), join(out, filename));
  const archive = await readFile(join(out, filename));
  const artifact = {
    url: `https://github.com/Shadowhusky/localdot-downloads/releases/download/v${version}/${filename}`,
    sha512: hash("sha512", archive),
    bytes: archive.length,
    files: Object.fromEntries(
      packed.files.map(({ path }) => {
        if (!finalFiles[path]) throw new Error("Uninventoried archive member");
        return [path, finalFiles[path]];
      }),
    ),
  };
  await writeFile(
    join(out, "artifact.json"),
    JSON.stringify(
      { v: 1, version, commit, target, artifact, bootstrapSHA256, accepted: false },
      null,
      2,
    ),
  );
  await writeFile(join(out, "runtime-receipt.json"), JSON.stringify(receipt, null, 2));
  let windows = await readFile(join(root, "install.ps1"), "utf8");
  windows = windows
    .replaceAll(
      "https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.sh",
      "https://downloads.localdot.dev/install.sh",
    )
    .replaceAll(
      "https://raw.githubusercontent.com/Shadowhusky/localdot/main/install.ps1",
      "https://downloads.localdot.dev/install.ps1",
    );
  await writeFile(join(out, "install.ps1"), windows);
  return artifact;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputFile] = process.argv.slice(2);
  if (!inputFile) throw new Error("Usage: build.mjs build-input.json");
  await buildDistribution(JSON.parse(await readFile(inputFile, "utf8")));
}
