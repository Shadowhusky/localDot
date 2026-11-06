// Everything the film's composition loads, into its ignored assets/ and models/ folders. From apps/site:
//   mkdir -p film-update/assets/clips && cp public/demos/breakout/theatre.mp4 film-update/assets/clips/breakout.mp4
//   node film-update/capture/frames.mjs && node film-update/capture/phone.mjs && node film-update/capture/phone.mjs --tall
//   node film-update/capture/desktop.mjs && node film-update/capture/desktop.mjs --tall switch view
//   node film-update/assets.mjs
// frames.mjs paints the sample pages, the takes record the real app against the UI fixture, and this
// bundles the 3D layer, dot's outfits, the type and the score. `node deliver.mjs`, from this folder, makes
// the masters and the site's copies.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const film = fileURLToPath(new URL(".", import.meta.url));
const run = (cmd, args, cwd = site) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npx", ["vite", "build", "--configLoader", "runner", "-c", "film-update/vite.config.ts"]);

mkdirSync(`${film}models`, { recursive: true });
for (const file of readdirSync(`${site}public/models`))
  if (/^(wear|shadow)-/.test(file))
    copyFileSync(`${site}public/models/${file}`, `${film}models/${file}`);

mkdirSync(`${film}assets/fonts`, { recursive: true });
copyFileSync(
  `${site}node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2`,
  `${film}assets/fonts/inter.woff2`,
);

run(
  "uv",
  [
    "run",
    "-q",
    "--with",
    "numpy",
    "--with",
    "scipy",
    "--with",
    "soundfile",
    "python",
    "score.py",
    "cues.json",
    "assets/music.wav",
  ],
  film,
);
