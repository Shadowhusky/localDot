# V0-2/3 findings: additive Spine head-turn rig in PixiJS v8

Date: 2026-09-30. Editor: Spine 4.3.26 Professional (launcher 4.3.08). Runtime:
`@esotericsoftware/spine-core` / `spine-pixi-v8` 4.3.13, `pixi.js` 8.21.0.

## Rig written by script (`make-rig.mjs` → `out/toy.json`)
One 5×5 face mesh (25 vertices, 32 triangles, hull 16 — hull vertices first, in order around the
edge), a hair region on a `hair` bone, two deform animations (`head-x`, `head-y`) keyed at
time 0 (full −1), 0.5 (neutral, no vertices) and 1 (full +1), two additive sliders driving them and
one physics constraint on the hair bone. Deform = 2.5D parallax: centre shifts up to 28 px, rim fixed.

JSON shapes that the 4.3 reader accepts (from `SkeletonJson.js`):
- `constraints: [...]` is ONE top-level array for every constraint type.
- Slider: `{ "name", "type": "slider", "additive": true, "time": 0.5, "animation": "head-x" }`.
  Optional bone-driven form: `"bone", "property" ("rotate"|"x"|…), "from", "to", "scale", "max",
  "local", "loop"`; without a bone, `time` is set at runtime.
- Physics: `{ "name", "type": "physics", "bone", "rotate": 1, "inertia": 0.5, "strength": 100,
  "damping": 0.85, "mass": 1, "gravity": 0 }` (also `x`, `y`, `scaleX`, `shearX`, `limit`, `fps`,
  `wind`, `mix` and `*Global` flags).
- Mesh attachment in `skins[].attachments.<slot>.<name>`: `{ "type": "mesh", "uvs", "triangles",
  "vertices", "hull", "width", "height" }`.
- Deform timeline: `animations.<anim>.attachments.<skin>.<slot>.<attachment>.deform: [{ "time",
  "offset"?, "vertices"? }]`; a key with no `vertices` is the setup pose.
- Set `skeleton.spine` to the editor's version ("4.3.26") or import warns about a mismatch.

## CLI round trip (exact commands)
    SPINE=/Applications/Spine.app/Contents/MacOS/Spine
    "$SPINE" -i out/toy.json -o out/toy.spine -r                  # import → project (3.7 s)
    "$SPINE" -i out/toy.spine -o "$PWD/out/export" -e binary+pack # → toy.skel, toy.atlas, toy.png
- Gotcha: the export's `-o` is resolved relative to the PROJECT file's folder, not the working
  directory — a relative `-o out/export` wrote to `out/out/export`. Always pass an absolute path.
- Only warning: "Nonessential unchecked when exporting, mesh internal edges lost" (editor-only
  data; harmless).

## Rendering (spine-pixi-v8)
- Load: `Assets.add({alias, src})` for `.skel` and `.atlas`, then `Spine.from({ skeleton, atlas })`.
- Drive a slider: `skeleton.findConstraint("head-x", Slider).pose.time = 0.5 + x / 2`.
- 3×3 grid of head X × Y ∈ {−1, 0, 1} (checked by eye in the browser): neutral is undeformed, each
  edge value moves the features the right way, and **all four corners are clean additive blends** —
  no collapse, no doubling, no tearing. The only distortion is the toy's square-mesh weighting at
  the circle's rim (a real rig weights by layer depth instead).
- 10 s oscillation of both sliders at 2× scale: **mean 145 fps, minimum 115 fps** (display-capped;
  far above 60). Deform stayed within the mesh's setup extents (max |v| = 128 px), so additive
  sliders do not accumulate frame to frame.
- Physics: moving `skeleton.x` (not the Pixi container, which physics does not see) swings the hair
  bone's WORLD rotation ±4.4° (85.6°–94.4°). Local `appliedPose.rotation` never changes — physics
  writes the world transform, so read `getWorldRotationX()` when checking it.
- Headless `chrome --screenshot` captures before async asset loading finishes (blank canvas);
  golden-pose tests in Part 2 need a page-ready flag plus Puppeteer/devtools capture.

## Result: GO
Scripted rigs import, export and render; additive sliders on one mesh combine correctly at the
corners and run far above 60 fps. `rig-gen` can emit this JSON directly.
