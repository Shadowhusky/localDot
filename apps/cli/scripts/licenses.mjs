import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE_FILE = /^(?:licen[cs]e|notice|copying)(?:[._-].+)?$/i;

async function packageFor(input, workspace) {
  if (input.includes("\0")) return undefined;
  const file = input.split("?")[0];
  const resolved = isAbsolute(file) ? file : resolve(workspace, file);
  const fromWorkspace = relative(workspace, resolved);
  const insideWorkspace =
    !isAbsolute(fromWorkspace) && fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`);
  // Resolved compiler inputs can be linked to an unpacked, pinned dependency outside node_modules.
  // Ignore only this workspace's own source, not those external packages.
  if (insideWorkspace && !file.includes("node_modules/")) return undefined;
  let dir = dirname(resolved);
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (typeof pkg.name === "string" && typeof pkg.version === "string") return { dir, pkg };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    dir = dirname(dir);
  }
  throw new Error("Bundled dependency package metadata is missing");
}

/** Preserve installed license/notice text for every package named in compiler module inventories. */
export async function writeDependencyNotices({ inputs, workspace, outDir }) {
  const packages = new Map();
  for (const input of inputs) {
    const result = await packageFor(input, workspace);
    if (result) packages.set(`${result.pkg.name}@${result.pkg.version}`, result);
  }
  const notices = [];
  for (const [identity, { dir, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name) ||
      !/^[A-Za-z0-9.+-]{1,64}$/.test(pkg.version)
    )
      throw new Error("Invalid dependency identity");
    let names = (await readdir(dir)).filter((name) => LICENSE_FILE.test(name)).sort();
    let licenseDir = dir,
      upstream,
      upstreamBlob;
    // This exact npm release omits LICENSE.md. The checked-in copy is from its version tag,
    // bound to the immutable upstream blob. Other versions/packages still fail when incomplete.
    if (!names.length && identity === "@pixi/colord@2.9.6" && pkg.license === "MIT") {
      licenseDir = fileURLToPath(new URL("../licenses/pixi-colord-2.9.6", import.meta.url));
      names = ["LICENSE.md"];
      upstream =
        "https://github.com/pixijs/colord/blob/5344fbf77b736f81cd33c21050021bc09bc9dd1d/LICENSE.md";
      upstreamBlob = "e437003733acd123c76c2a9df0c13a6f3b02b51e";
    }
    // This npm release also omits its license file. The retained Apache-2.0 text is from
    // the immutable source commit identified by the package's verified public provenance.
    if (!names.length && identity === "@sigstore/verify@4.0.0" && pkg.license === "Apache-2.0") {
      licenseDir = fileURLToPath(new URL("../licenses/sigstore-verify-4.0.0", import.meta.url));
      names = ["LICENSE"];
      upstream =
        "https://github.com/sigstore/sigstore-js/blob/7d2900eca1c22b3f87c13987c8d4b7c9a29b733a/LICENSE";
      upstreamBlob = "e9e7c1679a09dfcb0793682d99f5129e206a8abd";
    }
    if (!names.length) throw new Error(`Bundled dependency has no license file: ${identity}`);
    const parts = [
      Buffer.from(
        `${identity}\nPackage license: ${JSON.stringify(pkg.license ?? "unspecified")}\n\n`,
      ),
    ];
    if (upstream) parts.push(Buffer.from(`License source: ${upstream}\n\n`));
    for (const name of names) {
      const path = join(licenseDir, name),
        st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > 256 * 1024)
        throw new Error("Invalid dependency license file");
      const bytes = await readFile(path);
      if (
        upstream &&
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !==
          upstreamBlob
      )
        throw new Error("Pinned upstream license changed");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error("Invalid dependency license text");
      parts.push(Buffer.from(`===== ${name} =====\n`), bytes, Buffer.from("\n"));
    }
    const path = `${pkg.name.replace("/", "__")}-${pkg.version}.txt`;
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, path), Buffer.concat(parts), { flag: "wx" });
    notices.push({
      name: pkg.name,
      version: pkg.version,
      path,
      sourceFiles: names,
      ...(upstream ? { upstream } : {}),
    });
  }
  return notices;
}
