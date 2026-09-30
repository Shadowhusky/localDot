import { Slider } from "@esotericsoftware/spine-core";
import { Spine } from "@esotericsoftware/spine-pixi-v8";
import { Application, Assets, Text } from "pixi.js";

const CELL = 300;
const mode = new URLSearchParams(location.search).get("mode") ?? "grid";
const out = document.getElementById("out");

const app = new Application();
await app.init({ width: CELL * 3, height: CELL * 3, background: "#0A0B0D", antialias: true });
document.body.appendChild(app.canvas);

Assets.add({ alias: "toySkel", src: "/out/export/toy.skel" });
Assets.add({ alias: "toyAtlas", src: "/out/export/toy.atlas" });
await Assets.load(["toySkel", "toyAtlas"]);

const make = () => Spine.from({ skeleton: "toySkel", atlas: "toyAtlas" });
const sliders = (spine) => ({
  x: spine.skeleton.findConstraint("head-x", Slider),
  y: spine.skeleton.findConstraint("head-y", Slider),
});
// Slider time 0 = full left/down, 0.5 = neutral, 1 = full right/up.
const setTurn = (s, x, y) => {
  s.x.pose.time = 0.5 + x / 2;
  s.y.pose.time = 0.5 + y / 2;
};

if (mode === "grid") {
  const values = [-1, 0, 1];
  for (const [row, y] of [1, 0, -1].entries()) {
    for (const [col, x] of values.entries()) {
      const spine = make();
      spine.x = col * CELL + CELL / 2;
      spine.y = row * CELL + CELL / 2 + 40;
      setTurn(sliders(spine), x, y);
      app.stage.addChild(spine);
      const label = new Text({ text: `x ${x}  y ${y}`, style: { fill: "#999CA4", fontSize: 14 } });
      label.x = col * CELL + 8;
      label.y = row * CELL + 8;
      app.stage.addChild(label);
    }
  }
  window.__ready = true;
} else {
  const spine = make();
  spine.x = (CELL * 3) / 2;
  spine.y = (CELL * 3) / 2;
  spine.scale.set(2);
  app.stage.addChild(spine);
  const s = sliders(spine);
  const samples = [];
  const started = performance.now();
  let maxAbs = 0;
  const hair = spine.skeleton.findBone("hair");
  let hairMin = Number.POSITIVE_INFINITY;
  let hairMax = Number.NEGATIVE_INFINITY;
  app.ticker.add(() => {
    const t = (performance.now() - started) / 1000;
    setTurn(s, Math.sin(t * 2.1), Math.sin(t * 1.3));
    // Physics reacts to skeleton movement, not to the Pixi container moving.
    spine.skeleton.x = Math.sin(t * 3) * 60;
    samples.push(app.ticker.FPS);
    const verts = spine.skeleton.findSlot("face").appliedPose.deform;
    for (const v of verts) maxAbs = Math.max(maxAbs, Math.abs(v));
    if (t > 1) {
      hairMin = Math.min(hairMin, hair.appliedPose.getWorldRotationX());
      hairMax = Math.max(hairMax, hair.appliedPose.getWorldRotationX());
    }
    if (t > 10 && !window.__result) {
      const tail = samples.slice(Math.floor(samples.length / 2));
      window.__result = {
        frames: samples.length,
        meanFps: +(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(1),
        minFps: +Math.min(...tail).toFixed(1),
        maxDeformPx: +maxAbs.toFixed(1),
        hairRotationRange: [+hairMin.toFixed(1), +hairMax.toFixed(1)],
      };
      out.textContent = JSON.stringify(window.__result);
    }
  });
}
