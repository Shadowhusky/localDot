import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEYD_IDENTIFIER,
  KEYD_NATIVE_IDENTIFIER,
  KEYD_PACKAGE,
  PackagePath,
  ReleaseManifest,
} from "../../../packages/protocol/src/release.ts";
import {
  checkPack,
  MAX_FILE_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  PACK_ALLOWLIST,
} from "../../../scripts/check-pack.mjs";
import { verifyReleaseKeyd, verifyReleaseKeydNative } from "../src/install/keyd-verification.ts";
import { nativeDependencyPlan } from "../src/install/native-plan.ts";
import { KEYD_RELEASE_TEAM_ID } from "../src/install/release-trust.ts";
import { verifyStagedRelease } from "../src/install/staged-release.ts";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => new Error("App package build inputs failed verification.");
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const same = (a, b) =>
  ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );

async function bytesAt(path, max = MAX_FILE_BYTES) {
  if ((await realpath(path)) !== path) throw fail();
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(process.getuid?.() ?? -1) ||
    (before.mode & 0o7022n) !== 0n ||
    before.size > BigInt(max)
  )
    throw fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, await file.stat({ bigint: true }))) throw fail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw fail();
      offset += read.bytesRead;
    }
    if (
      !same(before, await file.stat({ bigint: true })) ||
      !same(before, await lstat(path, { bigint: true }))
    )
      throw fail();
    return bytes;
  } finally {
    await file.close();
  }
}

async function pathsIn(root) {
  const files = [],
    folded = new Set();
  let entries = 0;
  async function walk(dir, prefix) {
    const before = await lstat(dir, { bigint: true });
    if (
      !before.isDirectory() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o7022n) !== 0n ||
      (await realpath(dir)) !== dir
    )
      throw fail();
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const path = prefix + name;
      if (
        ++entries > MAX_PACKAGE_FILES * 2 ||
        !PackagePath.safeParse(path).success ||
        folded.has(path.toLowerCase())
      )
        throw fail();
      folded.add(path.toLowerCase());
      const absolute = join(dir, name),
        stat = await lstat(absolute);
      if (stat.isDirectory()) {
        const count = files.length;
        await walk(absolute, `${path}/`);
        if (count === files.length) throw fail();
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !PACK_ALLOWLIST.some((pattern) => pattern.test(path)) ||
          files.length >= MAX_PACKAGE_FILES
        )
          throw fail();
        files.push(path);
      }
    }
    if (
      JSON.stringify(names) !== JSON.stringify((await readdir(dir)).sort()) ||
      !same(before, await lstat(dir, { bigint: true }))
    )
      throw fail();
  }
  await walk(root, "");
  return files.sort();
}

/** Build-owned metadata is not a release trust token. Publication provenance, image availability,
 * native installation and installed acceptance are separate gates. verify is an offline test seam;
 * there is no CLI or environment override for the production signing identity.
 */
export async function buildAppPackage(
  input,
  verify = verifyReleaseKeyd,
  verifyNative = verifyReleaseKeydNative,
) {
  const { output, runtimeDirectory, keydBinary, keydNativeBinary, commit } = input;
  const runtime = structuredClone(input.runtimeReceipt),
    images = structuredClone(input.images);
  const out = resolve(output),
    source = resolve(runtimeDirectory),
    binary = resolve(keydBinary),
    nativeBinary = resolve(keydNativeBinary);
  const version = runtime?.version;
  // Validate untrusted build descriptions before any copying or executable verification.
  const base = ReleaseManifest.parse({
    v: 1,
    name: "localdot",
    version,
    commit,
    files: { "placeholder.txt": "0".repeat(64) },
    images,
    keyd: {
      package: KEYD_PACKAGE,
      path: "bin/keyd",
      sha256: "0".repeat(64),
      identifier: KEYD_IDENTIFIER,
      teamId: KEYD_RELEASE_TEAM_ID,
      native: {
        path: "bin/keyd-native",
        sha256: "0".repeat(64),
        identifier: KEYD_NATIVE_IDENTIFIER,
      },
    },
  });
  if (
    runtime.output !== source ||
    runtime.sandbox?.upstreamArchiveVerified !== true ||
    !Array.isArray(runtime.files) ||
    !runtime.files.length ||
    runtime.files.length > MAX_PACKAGE_FILES - 4
  )
    throw fail();
  const wanted = new Map();
  let total = 0;
  for (const item of runtime.files) {
    if (
      !PackagePath.safeParse(item.path).success ||
      wanted.has(item.path) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > MAX_FILE_BYTES
    )
      throw fail();
    total += item.size;
    if (total > MAX_PACKAGE_BYTES) throw fail();
    wanted.set(item.path, item);
  }
  const paths = await pathsIn(source);
  if (
    JSON.stringify(paths) !== JSON.stringify([...wanted.keys()].sort()) ||
    ["README.md", "LICENSE", "THIRD-PARTY.md", "release.json"].some((path) => wanted.has(path))
  )
    throw fail();
  const payload = new Map();
  for (const path of paths) {
    const bytes = await bytesAt(join(source, path)),
      item = wanted.get(path);
    if (bytes.length !== item.size || hash(bytes) !== item.sha256) throw fail();
    payload.set(path, bytes);
  }
  const pkg = json(payload.get("package.json")),
    lock = payload.get("npm-shrinkwrap.json");
  if (
    pkg.name !== "localdot" ||
    pkg.version !== version ||
    pkg.private !== true ||
    "scripts" in pkg ||
    JSON.stringify(pkg.bin) !== '{"localdot":"bin/localdot.mjs"}'
  )
    throw fail();
  nativeDependencyPlan(
    payload.get("package.json").toString("utf8"),
    lock.toString("utf8"),
    version,
  );
  const keyd = {
    ...base.keyd,
    sha256: hash(await bytesAt(binary, 64 * 1024 * 1024)),
    native: { ...base.keyd.native, sha256: hash(await bytesAt(nativeBinary, 64 * 1024 * 1024)) },
  };
  await verify(binary, keyd, AbortSignal.timeout(30000));
  await verifyNative(nativeBinary, keyd, AbortSignal.timeout(30000));
  // No input package hook, optional dependency or incidental metadata is promoted here.
  const packageJSON = {
    name: "localdot",
    version,
    type: "module",
    description: "A local computer agent",
    license: "MIT",
    bin: { localdot: "bin/localdot.mjs" },
    files: [
      "bin/",
      "dist/",
      "web/",
      "skills/",
      "release-notes/",
      "release.json",
      "THIRD-PARTY.md",
      "npm-shrinkwrap.json",
    ],
    engines: { node: ">=24" },
    os: ["darwin"],
    cpu: ["arm64"],
    dependencies: pkg.dependencies,
    repository: { type: "git", url: "https://github.com/Shadowhusky/localdot" },
  };
  payload.set("package.json", Buffer.from(`${JSON.stringify(packageJSON, null, 2)}\n`));
  payload.set("LICENSE", await bytesAt(join(workspace, "LICENSE")));
  payload.set(
    "README.md",
    Buffer.from(
      `# localDot\n\nA local computer agent for Apple Silicon Macs. Requires Node.js 24 or newer and a running local Docker engine.\n\nRun \`localdot\` to set up the app. Use \`localdot doctor\` to check the installation, \`localdot down\` to stop it, and \`localdot up\` to start it again. Run \`localdot --help\` for all commands.\n\nThe separate signed credential helper and pinned container images are verified during setup. Avatar modules are optional.\n\nSee THIRD-PARTY.md for included software notices.\n`,
    ),
  );
  const notices = paths.filter((path) => path.startsWith("web/dist/assets/licenses/"));
  payload.set(
    "THIRD-PARTY.md",
    Buffer.from(
      [
        "# Third-party software",
        "",
        "Full bundled dependency notices:",
        "",
        ...notices.map((path) => `- ${path} — SHA-256 ${hash(payload.get(path))}`),
        "",
        "Selkies: web/vendor/selkies/LICENSE and NOTICE.md.",
        "Patched sandbox: dist/sandbox-runtime/LICENSE, NOTICE.md and PATCH.txt.",
        "External native dependency versions and archive integrity: npm-shrinkwrap.json.",
        "",
      ].join("\n"),
    ),
  );
  const manifest = ReleaseManifest.parse({
    ...base,
    keyd,
    files: Object.fromEntries(
      [...payload]
        .filter(([path]) => path !== "package.json")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => [path, hash(bytes)]),
    ),
  });
  payload.set("release.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  // Fresh output only; a failed partial artifact has no successful receipt and is never reused.
  await mkdir(out, { mode: 0o700 });
  if ((await realpath(out)) !== out) throw fail();
  for (const [path, bytes] of payload) {
    await mkdir(dirname(join(out, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(out, path), bytes, {
      flag: "wx",
      mode: [
        "bin/localdot.mjs",
        "web/dist/native/localDot.app/Contents/MacOS/localdot-notify",
      ].includes(path)
        ? 0o700
        : 0o600,
    });
  }
  const files = [...payload].map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: hash(bytes),
  }));
  const problems = checkPack(out, { files });
  if (problems.length) throw new Error(`App package audit failed: ${problems.join("; ")}`);
  const metadataDigests = {
    packageJson: hash(payload.get("package.json")),
    releaseJson: hash(payload.get("release.json")),
  };
  await verifyStagedRelease(out, metadataDigests, AbortSignal.timeout(30000));
  await verify(binary, keyd, AbortSignal.timeout(30000));
  await verifyNative(nativeBinary, keyd, AbortSignal.timeout(30000));
  return {
    output: out,
    version,
    commit,
    files,
    metadataDigests,
    keyd,
    images: manifest.images,
    upstreamArchiveVerified: true,
    appMetadataBuilt: true,
    signatureVerified: true,
    releaseProvenanceVerified: false,
    imageAvailabilityVerified: false,
    cleanInstallVerified: false,
    completeRelease: false,
    published: false,
  };
}
