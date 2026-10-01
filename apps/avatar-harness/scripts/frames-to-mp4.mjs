// Usage: node frames-to-mp4.mjs <frames.json> <out.mp4>
// frames.json is the JSON array of PNG data URLs that record.html leaves in window.__frames.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node frames-to-mp4.mjs <frames.json> <out.mp4>");
  process.exit(2);
}
const frames = JSON.parse(readFileSync(input, "utf8"));
const dir = mkdtempSync(join(tmpdir(), "avatar-frames-"));
frames.forEach((dataUrl, i) => {
  writeFileSync(
    join(dir, `${String(i).padStart(4, "0")}.png`),
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
});
// The frames are transparent; premultiplying flattens them onto black instead of dropping alpha,
// which would leave every anti-aliased edge pixel at full strength.
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-v",
    "error",
    "-framerate",
    "30",
    "-i",
    join(dir, "%04d.png"),
    "-vf",
    "premultiply=inplace=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    output,
  ],
  { stdio: "inherit" },
);
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
