import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
// The bundle carries copies of these MIT packages, so it carries their notices too.
const notices = ["hono", "@hono/node-server"]
  .map((name) => `${name}\n\n${readFileSync(join(here, "node_modules", name, "LICENSE"), "utf8")}`)
  .join("\n");
await build({
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(here, "dist/desktopd.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "info",
  banner: {
    js: `/*!\n${notices}*/\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});
