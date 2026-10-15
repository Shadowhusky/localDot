import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    plugins: [
      {
        name: "deepseek-bundled-package-metadata",
        setup(builder) {
          builder.onLoad(
            {
              filter:
                /[/\\]@deepseek-ai[/\\](?:dsh-llm|dsh-repeat-tool-reminder)[/\\]lib[/\\]index\.js$/,
            },
            ({ path }) => {
              // DSH's LLM package and the pinned reminder's inlined copy read their
              // version using createRequire(import.meta.url). That relative path
              // no longer exists in our single-file, read-only image.
              // Embed only this audited package's metadata, never redirect require.
              const pkg = JSON.parse(readFileSync(join(dirname(path), "../package.json"), "utf8"));
              const source = readFileSync(path, "utf8");
              const lookup = 'createRequire(import.meta.url)("../package.json")';
              if (
                !["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-repeat-tool-reminder"].includes(
                  pkg.name,
                ) ||
                pkg.version !== "0.1.7-rc.2" ||
                source.split(lookup).length !== 2
              )
                throw new Error(
                  "brain: review DeepSeek package metadata bundling for this version",
                );
              return {
                contents: source.replace(lookup, JSON.stringify({ version: pkg.version })),
                loader: "js",
              };
            },
          );
        },
      },
    ],
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __localdotCreateRequire } from 'node:module'; const require = __localdotCreateRequire(import.meta.url);",
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
  if (resolve(root) === here) {
    // Execute the production artifact away from node_modules and package.json.
    // No credentials or tool endpoint are inherited, so entry must stop before
    // contacting services. This catches runtime-only packaging failures.
    const smoke = mkdtempSync(join(tmpdir(), "localdot-brain-smoke-"));
    try {
      const entry = join(smoke, "brain.mjs");
      writeFileSync(entry, code);
      const launched = spawnSync(process.execPath, [entry], {
        cwd: smoke,
        env: {},
        encoding: "utf8",
        timeout: 15000,
      });
      if (
        launched.error ||
        launched.status !== 2 ||
        !launched.stderr.includes("LOCALDOT_TOOL_URL and LOCALDOT_TOOL_TOKEN are required")
      )
        throw new Error(
          `brain: isolated bundle startup failed: ${launched.error?.message ?? launched.stderr}`,
        );
    } finally {
      rmSync(smoke, { recursive: true, force: true });
    }
  }
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
