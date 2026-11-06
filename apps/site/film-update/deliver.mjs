// The finished film, from apps/site/film-update, for both languages or those named, and the 9:16 cut:
//   nice -n 10 node deliver.mjs [en] [zh] [vertical] [--posters]
// The masters go to renders/ (1080p60, CRF 14, AAC 320k), the site's copies to ../public/film, and the
// README's poster to docs/readme. The render's sound comes out quiet, so it is normalised once, in two
// passes, to -16.5 LUFS with true-peak headroom for the AAC encode.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const site = fileURLToPath(new URL("../public/film/", import.meta.url));
const readme = fileURLToPath(new URL("../../../docs/readme/update.jpg", import.meta.url));
const POSTER_AT = 4.5;
const named = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const langs = named.length ? named : ["en", "zh", "vertical"];
// The site's posters and the README's picture are made only when asked for.
const posters = process.argv.includes("--posters");
const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];
// Gentle on a Mac that's in use: few threads and workers, at the lowest priority.
const ffmpeg = (...args) =>
  execFileSync(
    "nice",
    ["-n", "20", "ffmpeg", ...QUIET, ...args.slice(0, -1), "-threads", "2", ...args.slice(-1)],
    { stdio: "inherit" },
  );

// The render runs at this script's own priority: HyperFrames sets its setup to the low priority itself, which
// a process already below that isn't allowed to. Run this at `nice -n 10`.
const renderTo = (dir, out, extra = []) =>
  execFileSync(
    "npx",
    [
      "--yes",
      "hyperframes@0.8.160",
      "render",
      "-q",
      "delivery",
      "-f",
      "60",
      "--crf",
      "14",
      "--workers",
      "2",
      ...extra,
      "-o",
      out,
    ],
    { cwd: dir, stdio: "inherit" },
  );

function normalised(raw, sound) {
  const measure = spawnSync(
    "nice",
    [
      "-n",
      "20",
      "ffmpeg",
      "-hide_banner",
      "-i",
      raw,
      "-af",
      "loudnorm=I=-16.5:TP=-3.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  ).stderr;
  const m = JSON.parse(measure.slice(measure.lastIndexOf("{"), measure.lastIndexOf("}") + 1));
  ffmpeg(
    "-i",
    raw,
    "-vn",
    "-af",
    `loudnorm=I=-16.5:TP=-3.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar",
    "48000",
    sound,
  );
}

mkdirSync(`${here}renders`, { recursive: true });
for (const lang of langs) {
  if (lang === "vertical") {
    const raw = `${here}renders/raw-vertical.mp4`;
    const sound = `${here}renders/sound-vertical.wav`;
    const master = `${here}renders/localdot-update-zh-vertical.mp4`;
    renderTo(`${here}vertical`, raw);
    normalised(raw, sound);
    ffmpeg(
      "-i",
      raw,
      "-i",
      sound,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-movflags",
      "+faststart",
      master,
    );
    rmSync(sound);
    console.log(master);
    continue;
  }
  const zh = lang === "zh" ? "-zh" : "";
  const raw = `${here}renders/raw${zh}.mp4`;
  renderTo(here, raw, zh ? ["--variables", '{"lang":"zh"}', "--strict-variables"] : []);
  const sound = `${here}renders/sound${zh}.wav`;
  normalised(raw, sound);
  const master = `${here}renders/localdot-update${zh}-1080p.mp4`;
  ffmpeg(
    "-i",
    raw,
    "-i",
    sound,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-movflags",
    "+faststart",
    master,
  );
  ffmpeg(
    "-i",
    raw,
    "-i",
    sound,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    `${site}localdot-update${zh}.mp4`,
  );
  ffmpeg(
    "-i",
    raw,
    "-i",
    sound,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-vf",
    "scale=-2:720:flags=lanczos",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    `${site}localdot-update${zh}-720.mp4`,
  );
  if (posters) {
    const still = `${here}renders/poster${zh}.png`;
    ffmpeg(
      "-ss",
      String(POSTER_AT),
      "-i",
      master,
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:-2:flags=lanczos",
      still,
    );
    execFileSync("cwebp", ["-quiet", "-q", "82", still, "-o", `${site}poster-update${zh}.webp`]);
    if (!zh) ffmpeg("-i", still, "-q:v", "3", readme);
    rmSync(still);
  }
  rmSync(sound);
  console.log(master);
}
