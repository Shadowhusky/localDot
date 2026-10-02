import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const options = {
  absWorkingDir: here,
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(here, "dist/desktopd.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
};

// The bundle carries copies of these packages, so it carries their notices too: every package
// esbuild read an input from, each with its license file (a package without one stops the build).
const { metafile } = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
const roots = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) roots.add(resolve(here, m[1]));
}
const notices = [...roots]
  .map((root) => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const file = readdirSync(root).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
    if (!file) throw new Error(`${pkg.name} ${pkg.version} has no license file to bundle`);
    const text = readFileSync(join(root, file), "utf8").replaceAll("*/", "* /");
    return { name: pkg.name, notice: `${pkg.name} ${pkg.version} (${pkg.license})\n\n${text}` };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
console.log(
  `desktopd bundles ${notices.length} packages: ${notices.map((n) => n.name).join(", ")}`,
);
await build({
  ...options,
  logLevel: "info",
  banner: {
    js: `/*!\n${notices.map((n) => n.notice).join("\n")}*/\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});

// The cell's proxy forwarder has only Node built-ins and runs as its own s6 service.
await build({
  entryPoints: [join(here, "src/forwarder-main.ts")],
  outfile: join(here, "dist/forwarder.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "info",
});
