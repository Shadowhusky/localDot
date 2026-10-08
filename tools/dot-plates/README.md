# dot plates

dot's body is a few static renders of a soft porcelain sphere ("plates"); a procedural SVG face in
`apps/web/src/dot` draws everything that moves. A uniform sphere looks the same however it turns, so
one plate stays correct for every gaze. Regenerate the plates only when the look changes.

| File | What it is |
| --- | --- |
| `build_plates.py` | Blender scene: body, five area lights, orthographic camera, shadow catcher |
| `plates.json` | The look: material, light rig, and the `xenon` and `dim` variants |
| `derive.py` | Masters to the shipping WebP sizes in `apps/web/src/dot/plates` |

The plates:

- `body-neutral`: the default body.
- `body-xenon`: dot has control. The rim and a low back kick are gelled `#3fb5de`; the key stays
  neutral.
- `body-dim`: offline, with the key at 30%.
- `shadow`: ambient occlusion on a shadow catcher, cast by a smaller hidden sphere so it reads as a
  soft core.

Each plate covers the dot's 64-unit frame with the body at radius 24 in the middle, so an N px plate
is an N px dot.

## Regenerate

Render the 1024 px, 16-bit masters outside the repo (about 70 s with Cycles on Metal), then derive the
shipping sizes:

```sh
Blender --background --factory-startup --python tools/dot-plates/build_plates.py -- \
  --out /tmp/dot-masters --blend /tmp/dot-masters/dot-plates.blend
python3 -I tools/dot-plates/derive.py /tmp/dot-masters
```

`derive.py` needs ImageMagick (`magick`) and `cwebp`. Commit the WebP files only. The masters and the
`.blend` stay out of git; attach the `.blend` to a release if it needs keeping.
