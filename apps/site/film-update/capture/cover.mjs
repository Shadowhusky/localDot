// The vertical cut's covers: its Chat or Studio shot with a larger title and a larger dot, as a real
// frame of the composition, framed 9:16 and 3:4.
//   node film-update/capture/cover.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const film = fileURLToPath(new URL("../", import.meta.url));
const dir = `${film}renders/.cover/`;
const AT = 7.25;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
symlinkSync("../../assets", `${dir}assets`);
symlinkSync("../../models", `${dir}models`);
const page = readFileSync(`${film}vertical/index.html`, "utf8")
  .replace('data-format="tall"', 'data-format="tall" data-cover')
  .replace(
    "\n    </style>",
    `
      #w-views {
        top: 186px;
      }

      #w-views h2 {
        font-size: 104px;
      }
    </style>`,
  )
  .replace(/(<div [^>]*id="w-views"[^>]*>\s*<h2)[^>]*>.*?<\/h2>/s, "$1 data-cover-title></h2>");
writeFileSync(`${dir}index.html`, page);
writeFileSync(`${dir}hyperframes.json`, readFileSync(`${film}hyperframes.json`));
execFileSync(
  "npx",
  [
    "--yes",
    "hyperframes@0.8.160",
    "snapshot",
    "--at",
    String(AT),
    "--no-end",
    "-o",
    `${dir}shots`,
    "--describe",
    "false",
    "--timeout",
    "30000",
  ],
  { cwd: dir, stdio: "inherit" },
);
const shot = `${dir}shots/frame-00-at-${AT}s.png`;
const jpg = (crop, out) =>
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    shot,
    "-vf",
    crop,
    "-q:v",
    "2",
    `${film}renders/${out}`,
  ]);
jpg("crop=1080:1920:0:0", "cover-zh-9x16.jpg");
jpg("crop=1080:1440:0:130", "cover-zh-3x4.jpg");
rmSync(dir, { recursive: true, force: true });
console.log("done");
