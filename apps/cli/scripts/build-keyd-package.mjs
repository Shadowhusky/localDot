import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  KEYD_IDENTIFIER,
  KEYD_PACKAGE,
  RELEASE_VERSION,
} from "../../../packages/protocol/src/release.ts";
import { verifyReleaseKeyd } from "../src/install/keyd-verification.ts";
import { KEYD_RELEASE_TEAM_ID } from "../src/install/release-trust.ts";

const execute = promisify(execFile),
  workspace = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const failure = () => new Error("Signed helper package inputs do not match the release build.");
async function boundedFile(path, max = 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > max) throw failure();
  return readFile(path);
}
async function go(args) {
  const { stdout } = await execute("go", args, {
    cwd: join(workspace, "keyd"),
    env: { ...process.env, GOENV: "off", GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** Local author build only. It reads an already-signed trimpath binary and cached public license
 * inputs; it never signs, downloads modules, executes keyd, notarizes or publishes anything.
 * verify is an offline test seam, not a release configuration option.
 */
export async function buildKeydPackage({ output, binary, version }, verify = verifyReleaseKeyd) {
  if (typeof version !== "string" || version.length > 64 || !RELEASE_VERSION.test(version))
    throw failure();
  const path = await realpath(binary),
    bytes = await boundedFile(path, 16 * 1024 * 1024),
    sha256 = hash(bytes);
  const expected = {
    package: KEYD_PACKAGE,
    path: "bin/keyd",
    sha256,
    identifier: KEYD_IDENTIFIER,
    teamId: KEYD_RELEASE_TEAM_ID,
  };
  const abort = new AbortController().signal;
  await verify(path, expected, abort);
  const info = await go(["version", "-m", "-json", path]),
    env = await go(["env", "-json", "GOROOT", "GOPATH", "GOVERSION"]);
  const settings = new Map((info.Settings ?? []).map((item) => [item.Key, item.Value]));
  if (
    info.Path !== "github.com/shadowhusky/localdot/keyd/cmd/keyd" ||
    info.Main?.Path !== "github.com/shadowhusky/localdot/keyd" ||
    info.GoVersion !== env.GOVERSION ||
    settings.get("GOOS") !== "darwin" ||
    settings.get("GOARCH") !== "arm64" ||
    settings.get("CGO_ENABLED") !== "1" ||
    settings.get("-trimpath") !== "true" ||
    settings.get("-buildmode") !== "exe" ||
    settings.get("-race") === "true" ||
    !Array.isArray(info.Deps) ||
    info.Deps.length > 32
  )
    throw failure();
  const sums = new Set(
    (await readFile(join(workspace, "keyd/go.sum"), "utf8")).trim().split(/\r?\n/),
  );
  const notices = [];
  let goLicense = join(env.GOROOT, "LICENSE");
  try {
    await lstat(goLicense);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    goLicense = join(dirname(env.GOROOT), "LICENSE");
  }
  notices.push({
    path: "licenses/go.txt",
    module: "Go standard library",
    version: info.GoVersion,
    source: "https://go.dev",
    bytes: await boundedFile(goLicense),
  });
  const seen = new Set();
  for (const dep of info.Deps) {
    if (
      dep.Replace ||
      !/^[a-z0-9.-]+\/[a-z0-9/_-]+$/.test(dep.Path) ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(dep.Version) ||
      !/^h1:[A-Za-z0-9+/]{43}=$/.test(dep.Sum) ||
      !sums.has(`${dep.Path} ${dep.Version} ${dep.Sum}`) ||
      seen.has(dep.Path)
    )
      throw failure();
    seen.add(dep.Path);
    const file = `licenses/${dep.Path.replace(/[^a-z0-9]/g, "-")}.txt`;
    const license = join(
      env.GOPATH.split(":")[0],
      "pkg/mod",
      `${dep.Path}@${dep.Version}`,
      "LICENSE",
    );
    notices.push({
      path: file,
      module: dep.Path,
      version: dep.Version,
      source: `https://${dep.Path}`,
      bytes: await boundedFile(license),
    });
  }
  if (new Set(notices.map((n) => n.path)).size !== notices.length) throw failure();
  const ownLicense = await boundedFile(join(workspace, "LICENSE"));
  const out = resolve(output);
  await mkdir(out, { mode: 0o700 });
  await mkdir(join(out, "bin"), { mode: 0o700 });
  await mkdir(join(out, "licenses"), { mode: 0o700 });
  await copyFile(path, join(out, "bin/keyd"));
  await chmod(join(out, "bin/keyd"), 0o700);
  await verify(join(out, "bin/keyd"), expected, abort);
  await writeFile(join(out, "LICENSE"), ownLicense, { flag: "wx", mode: 0o600 });
  for (const notice of notices)
    await writeFile(join(out, notice.path), notice.bytes, { flag: "wx", mode: 0o600 });
  const lines = [
    "# Third-party software",
    "",
    ...notices.flatMap((n) => [
      `- ${n.module} ${n.version}: ${n.source}; full license: ${n.path}; SHA-256: ${hash(n.bytes)}`,
    ]),
    "",
  ];
  await writeFile(join(out, "THIRD-PARTY.md"), lines.join("\n"), { flag: "wx", mode: 0o600 });
  await writeFile(
    join(out, "package.json"),
    `${JSON.stringify({ name: KEYD_PACKAGE, version, description: "Signed native credential helper for localDot", license: "MIT", os: ["darwin"], cpu: ["arm64"], files: ["bin/keyd", "LICENSE", "THIRD-PARTY.md", "licenses"], repository: { type: "git", url: "https://github.com/Shadowhusky/localdot" } }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    output: out,
    version,
    keyd: expected,
    goVersion: info.GoVersion,
    notices: notices.map(({ bytes, ...notice }) => ({ ...notice, sha256: hash(bytes) })),
    notarized: false,
  };
}

/** Keep build evidence outside the publishable package tree. The command never accepts a
 * replacement signature policy; the injectable builder exists only for offline tooling tests.
 */
export async function buildKeydPackageReceipt(
  { output, binary, version, receipt },
  build = buildKeydPackage,
) {
  const out = resolve(output),
    evidence = resolve(receipt),
    rel = relative(out, evidence);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw failure();
  if (
    (await realpath(dirname(out))) !== dirname(out) ||
    (await realpath(dirname(evidence))) !== dirname(evidence)
  )
    throw failure();
  const built = await build({ output: out, binary: resolve(binary), version });
  const result = {
    ...built,
    // A signed executable and matching Go metadata do not bind this working tree to a release.
    sourceCommitVerified: false,
    releaseProvenanceVerified: false,
    completeRelease: false,
    published: false,
  };
  await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt: evidence, result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, version, output, receipt, ...extra] = process.argv.slice(2);
  if (!binary || !version || !output || !receipt || extra.length) {
    console.error(
      "Usage: build-keyd-package.mjs <signed-keyd> <version> <new-package-directory> <receipt.json>",
    );
    process.exitCode = 2;
  } else {
    try {
      const built = await buildKeydPackageReceipt({ output, binary, version, receipt });
      console.log(
        JSON.stringify({
          output: built.result.output,
          receipt: built.receipt,
          version: built.result.version,
          completeRelease: false,
        }),
      );
    } catch {
      console.error("Signed helper build failed. Partial output is not a verified release.");
      process.exitCode = 1;
    }
  }
}
