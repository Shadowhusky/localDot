// Verify change inside the computer screen, not merely its clock, mascot or outer panels.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const results = [];
for (const name of ["work", "research", "play", "work-mobile", "research-mobile", "play-mobile"]) {
  const video = `${root}public/demos/${name}.mp4`;
  const box = JSON.parse(readFileSync(`${root}qa/real-capture/${name}-0-screen.json`));
  const provenance = JSON.parse(readFileSync(`${root}qa/real-capture/${name}-provenance.json`));
  if (provenance.source !== "actual localDot task replay")
    throw Error(`${name}: actual-task provenance missing`);
  const meta = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=width,height",
      "-of",
      "json",
      video,
    ]),
  );
  const w = Math.floor(box.width),
    h = Math.floor(box.height * 0.8),
    x = Math.floor(box.x),
    y = Math.floor(box.y + box.height * 0.1);
  const bytes = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      `crop=${w}:${h}:${x}:${y},fps=2,scale=160:100`,
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  const frameBytes = 16000,
    frames = Math.floor(bytes.length / frameBytes);
  let changes = 0,
    maxChanged = 0;
  for (let f = 1; f < frames; f++) {
    let changed = 0;
    for (let p = 0; p < frameBytes; p++)
      if (Math.abs(bytes[f * frameBytes + p] - bytes[(f - 1) * frameBytes + p]) > 12) changed++;
    const fraction = changed / frameBytes;
    maxChanged = Math.max(maxChanged, fraction);
    if (fraction > 0.003) changes++;
  }
  if (changes < 3) throw Error(`${name}: screen has too few visible changes (${changes})`);
  const size = statSync(video).size;
  if (size > 4 * 1024 * 1024) throw Error(`${name}: exceeds bounded video playback size`);
  results.push({
    name,
    duration: Number(meta.format.duration),
    bytes: size,
    screenChanges: changes,
    maxChangedFraction: maxChanged,
    source: provenance.source,
  });
}
writeFileSync(`${root}qa/real-demo-motion.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
