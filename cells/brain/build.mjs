import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repository = (pkg) =>
  String(typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? ""))
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");

export function collectNotices(inputs, workingDirectory) {
  const roots = new Set();
  for (const input of inputs) {
    const normalized = input.replaceAll("\\", "/");
    const match = [...normalized.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1);
    if (match)
      roots.add(resolve(workingDirectory, normalized.slice(0, match.index + match[0].length - 1)));
  }
  const packages = [...roots].map((root) => ({
    root,
    pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  }));
  const notices = [];
  for (const { root, pkg } of packages) {
    let licenseRoot = root;
    let licenses = readdirSync(root).filter((name) => /^licen[cs]e(?:[.-].+)?$/i.test(name));
    let fallback;
    if (!licenses.length && pkg.name === "@ai-sdk/provider-utils" && pkg.version === "5.0.52") {
      // Audited exact pins: both packages identify vercel/ai and Apache-2.0. provider-utils
      // publishes no license file; ai's full repository license applies to that same source.
      const source = packages.find(({ pkg: p }) => p.name === "ai" && p.version === "7.0.123");
      if (
        source &&
        pkg.license === "Apache-2.0" &&
        source.pkg.license === "Apache-2.0" &&
        repository(pkg) === "https://github.com/vercel/ai" &&
        repository(source.pkg) === repository(pkg)
      ) {
        licenseRoot = source.root;
        licenses = readdirSync(licenseRoot).filter((name) => /^licen[cs]e(?:[.-].+)?$/i.test(name));
        fallback = "ai@7.0.123 (same repository and Apache-2.0 license)";
      }
    }
    if (!licenses.length)
      throw new Error(`brain: ${pkg.name}@${pkg.version} has no verified license file`);
    const files = [
      ...licenses.sort().map((name) => ({ path: join(licenseRoot, name), name })),
      ...readdirSync(root)
        .filter((name) => /^notice(?:[.-].+)?$/i.test(name))
        .sort()
        .map((name) => ({ path: join(root, name), name })),
    ];
    const records = files.map(({ path, name }) => {
      const text = readFileSync(path, "utf8");
      if (!text.trim()) throw new Error(`brain: ${pkg.name}@${pkg.version} has an empty notice`);
      return { name, text, sha256: createHash("sha256").update(text).digest("hex") };
    });
    notices.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      ...(fallback ? { fallback } : {}),
      files: records,
    });
  }
  return notices.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export async function buildBrain(root = here) {
  const out = join(root, "dist/brain.mjs");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src/main.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const notices = collectNotices(Object.keys(result.metafile.inputs), root);
  const header = notices
    .map(
      (p) =>
        `${p.name}@${p.version} (${p.license})${p.fallback ? `\nLicense supplied by ${p.fallback}` : ""}\n\n${p.files.map((f) => `${f.name}\n${f.text}`).join("\n")}`,
    )
    .join("\n\n");
  const code = `/*!\n${header.replaceAll("*/", "* /")}\n*/\n${result.outputFiles[0].text}`;
  mkdirSync(dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, code);
    renameSync(temporary, out);
  } finally {
    rmSync(temporary, { force: true });
  }
  const evidence = notices.map(({ files, ...p }) => ({
    ...p,
    files: files.map(({ name, sha256 }) => ({ name, sha256 })),
  }));
  writeFileSync(join(root, "dist/brain.licenses.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `brain: ${notices.length} bundled packages: ${notices.map((p) => `${p.name}@${p.version}`).join(", ")}`,
  );
  return { packages: notices.length, bytes: Buffer.byteLength(code) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildBrain();
