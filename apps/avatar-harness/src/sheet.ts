import { Spine } from "@esotericsoftware/spine-pixi-v8";
import { applyPose, bindingProblems, fitFrame, mapParams } from "@localdot/avatar-spine";
import { Application, Assets, Text } from "pixi.js";
import { loadPack } from "./packs.ts";
import { SHEET_POSES } from "./sheet-poses.ts";

const COLUMNS = 6;
const CELL_W = 240;
const CELL_H = 320;
const LABEL_H = 22;

const options = await loadPack(
  new URLSearchParams(location.search).get("pack") === "dev" ? "dev" : "toy",
);
Assets.add({ alias: options.skeletonUrl, src: options.skeletonUrl });
Assets.add({ alias: options.atlasUrl, src: options.atlasUrl });
await Assets.load([options.skeletonUrl, options.atlasUrl]);
const { skeletonData } = Spine.createOptions({
  skeleton: options.skeletonUrl,
  atlas: options.atlasUrl,
});
const problems = bindingProblems(options.binding, skeletonData);
if (problems.length > 0) {
  throw new Error(`avatar rig does not match its binding: ${problems.join("; ")}`);
}

const rows = Math.ceil(SHEET_POSES.length / COLUMNS);
const app = new Application();
await app.init({
  width: COLUMNS * CELL_W,
  height: rows * CELL_H,
  background: "#0A0B0D",
  antialias: true,
  preserveDrawingBuffer: true,
});
document.body.appendChild(app.canvas);

for (const [i, cell] of SHEET_POSES.entries()) {
  const spine = Spine.from({
    skeleton: options.skeletonUrl,
    atlas: options.atlasUrl,
    autoUpdate: false,
  });
  const placement = fitFrame(options.frames.glance, options.root, CELL_W, CELL_H - LABEL_H);
  if (!placement) continue;
  const x0 = (i % COLUMNS) * CELL_W;
  const y0 = Math.floor(i / COLUMNS) * CELL_H;
  spine.scale.set(placement.scale);
  spine.position.set(x0 + placement.x, y0 + LABEL_H + placement.y);
  applyPose(spine.skeleton, mapParams(cell.params, options.binding));
  spine.update(0);
  app.stage.addChild(spine);
  const label = new Text({
    text: cell.label,
    style: { fill: "#999CA4", fontSize: 14, fontFamily: "-apple-system, Inter, sans-serif" },
  });
  label.position.set(x0 + 8, y0 + 4);
  app.stage.addChild(label);
}
app.render();
Object.assign(window, { __sheetReady: true });
