import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const options = {
  absWorkingDir: directory,
  entryPoints: [join(directory, "src/main.ts")],
  outfile: join(directory, "dist/browserd.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
};
const { metafile } = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
const packages = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) packages.add(resolve(directory, match[1]));
}
const notices = [...packages]
  .map((root) => {
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const license = readdirSync(root).find((name) => /^licen[cs]e(\.(md|txt))?$/i.test(name));
    if (!license)
      throw new Error(`${metadata.name} ${metadata.version} has no license file to bundle`);
    const text = readFileSync(join(root, license), "utf8").replaceAll("*/", "* /");
    return {
      name: metadata.name,
      text: `${metadata.name} ${metadata.version} (${metadata.license})\n\n${text}`,
    };
  })
  .sort((first, second) => first.name.localeCompare(second.name));
await build({
  ...options,
  logLevel: "info",
  banner: {
    js: `/*!\n${notices.map((notice) => notice.text).join("\n")}*/\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});
await build({
  entryPoints: [join(directory, "../../desktop/desktopd/src/forwarder-main.ts")],
  outfile: join(directory, "dist/forwarder.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "info",
});
console.log(
  `browserd bundles ${notices.length} licensed packages: ${notices.map((notice) => notice.name).join(", ")}`,
);
