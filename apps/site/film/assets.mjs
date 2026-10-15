// Everything the film's composition loads, into its ignored assets/ and models/ folders:
//   node film/assets.mjs
// the 3D layer bundled from src/film, dot's outfits, the type, the demos' recordings and the score.
// The app's window comes from film/capture.mjs, which needs the site running.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const film = fileURLToPath(new URL(".", import.meta.url));
const run = (cmd, args, cwd = site) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npx", ["vite", "build", "--configLoader", "runner", "-c", "film.vite.config.ts"]);

mkdirSync(`${film}models`, { recursive: true });
for (const file of readdirSync(`${site}public/models`))
  if (/^(wear|shadow)-/.test(file))
    copyFileSync(`${site}public/models/${file}`, `${film}models/${file}`);

mkdirSync(`${film}assets/fonts`, { recursive: true });
copyFileSync(
  `${site}node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2`,
  `${film}assets/fonts/inter.woff2`,
);

mkdirSync(`${film}assets/clips`, { recursive: true });
for (const demo of ["breakout", "kyoto", "spending", "poster", "teaser"])
  copyFileSync(`${site}public/demos/${demo}/theatre.mp4`, `${film}assets/clips/${demo}.mp4`);
for (const card of ["captions", "band", "corner"])
  copyFileSync(
    `${site}public/demos/breakout/card-${card}.mp4`,
    `${film}assets/clips/card-${card}.mp4`,
  );
// The rewind: Breakout's game played backwards, four times as fast.
run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-ss",
  "18",
  "-t",
  "8",
  "-i",
  `${site}public/demos/breakout/theatre.mp4`,
  "-vf",
  "reverse,setpts=PTS/4",
  "-an",
  "-c:v",
  "libx264",
  "-crf",
  "20",
  "-g",
  "15",
  "-pix_fmt",
  "yuv420p",
  `${film}assets/clips/rewind.mp4`,
]);

// Where the paddle is while the visitor has control, for the cursor to ride.
const cues = JSON.parse(readFileSync(`${film}cues.json`, "utf8"));
run(
  "uv",
  [
    "run",
    "-q",
    "--with",
    "numpy",
    "python",
    "paddle.py",
    `assets/clips/${cues.work.demo}.mp4`,
    String(cues.work.from),
    String(cues.marks.models + 0.4 - cues.marks.step),
    "assets/paddle.json",
  ],
  film,
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
