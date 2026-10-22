# dot plates

dot's body is a few static renders of a soft porcelain sphere ("plates"); a procedural SVG face in
`apps/web/src/dot` draws everything that moves. A uniform sphere looks the same however it turns, so
one plate stays correct for every gaze. Regenerate the plates only when the look changes.

| File | What it is |
| --- | --- |
| `build_plates.py` | Blender scene: body, five area lights, orthographic camera, shadow catcher |
| `build_wearables.py` | What each dot wears, rendered over the same body and light rig |
| `plates.json` | The look: material, light rig, and the `xenon` and `dim` variants |
| `derive.py` | Masters to the shipping WebP sizes in `apps/web/src/dot/plates` |
| `export_glb.py` | The wearables as glTF models for the site's 3D dot (see Web models) |

The plates:

- `body-neutral`: the default body.
- `body-xenon`: dot has control. The rim and a low back kick are gelled `#3fb5de`; the key stays
  neutral.
- `body-dim`: offline, with the key at 30%.
- `shadow`: ambient occlusion on a shadow catcher, cast by a smaller hidden sphere so it reads as a
  soft core.

Each plate covers the dot's 64-unit frame with the body at radius 24 in the middle, so an N px plate
is an N px dot.

The wearables (`wear-<name>`, one per `Wearable` in `@localdot/protocol`) are transparent plates of
the same frame. The body is a shadow catcher in their scene, so each plate keeps the shadow its
wearable casts on dot and nothing of dot itself. DotView lays them over the face inside the body, so
they hop and squash with it: glasses and the mustache turn with the face as the eyes do; hats, the
headphones and the bow take a share of the turn about the point where their front meets the head
(`HEAD` in `render/wearables.ts`); clothes and the star pin turn only with the face's roll. On the
site, whatever sits on the head turns with the face whole.

## Regenerate

Render the 1024 px, 16-bit masters outside the repo (about 70 s with Cycles on Metal), then derive the
shipping sizes:

```sh
Blender --background --factory-startup --python tools/dot-plates/build_plates.py -- \
  --out /tmp/dot-masters --blend /tmp/dot-masters/dot-plates.blend
python3 -I tools/dot-plates/derive.py /tmp/dot-masters
Blender --background --factory-startup --python tools/dot-plates/build_wearables.py -- \
  --out /tmp/dot-wear [--only hoodie,suit]
python3 -I tools/dot-plates/derive.py /tmp/dot-wear
```

The wearables take about 30 s each at full quality; `--res 512 --samples 64` previews one in a few
seconds.

`derive.py` needs ImageMagick (`magick`) and `cwebp`. Commit the WebP files only. The masters and the
`.blend` stay out of git; attach the `.blend` to a release if it needs keeping.

## Web models

localdot.dev draws dot in 3D. `export_glb.py` builds every wearable with `build_wearables.py` and
writes, into `--out`:

- `wear-<name>.glb`: the wearable in place on the body, with its modifiers applied, decimated to a
  budget and baked with Cycles to WebP textures (`EXT_texture_webp`): base colour, and at half its
  size a tangent-space normal map and ORM (occlusion baked with the body present, roughness,
  metalness). Sheen, coat and specular stay as material constants. Glass stays glass: the round
  lenses transmit and the shades' lenses blend. Where the plates never needed more than the front,
  the model adds what a turntable shows: a pin behind the star.
- `shadow-<name>.webp`: the shadow the wearable casts on the body under the neutral rig, a linear
  factor that multiplies the body's colour (1 where it casts none), 512 x 256.
- `dot-rig.json`: the body's radius and porcelain, the eye anchors, the light rigs (`neutral`,
  `xenon`, `dim`) and the floor in the models' axes, and each model's triangles, size and bounds.
- `studio-env.hdr` and `studio-env-xenon.hdr`: the rig and the world seen from the body's centre,
  1024 x 512, for image-based light.

The site ships the models and their shadows; the rig and the environment maps describe the light
the site's own rig (`apps/site/src/dot3d/rig.ts`) stands in for.

```sh
Blender --background --factory-startup --python tools/dot-plates/export_glb.py -- \
  --out /tmp/dot-web [--only hoodie,suit]
cp /tmp/dot-web/wear-*.glb /tmp/dot-web/shadow-*.webp apps/site/public/models/
```

All twelve take about five minutes with Cycles on Metal.

Conventions:

- Units are body radii: the body is a sphere of radius 1 at the origin, and every model sits on it
  as it is, with no transform.
- Axes are glTF's, turned 9 degrees (the plate camera's elevation) about X, so a camera on +Z
  looking at the origin sees what the plates show: dot faces +Z with the plate's up as +Y. The world's
  up, toward the floor's normal, is `up` in `dot-rig.json`.
- A shadow map's u is longitude and v latitude in those axes: u = 0.5 + atan2(x, z) / 2pi,
  v = 0.5 + asin(y) / pi, with v = 1 the top row. These are the UVs of three.js's
  `SphereGeometry(1, w, h, -Math.PI / 2)` with a texture loaded as `TextureLoader` loads it.
- The environment maps are equirectangular as three.js maps them (u = 0.5 + atan2(z, x) / 2pi, the top
  row +Y), so they apply unrotated.

Budgets: 4,500 to 8,000 triangles for clothes and hats and 600 to 4,000 for the small things. Each
part keeps the fewest triangles that stay within one distance of its surface, the smallest distance
the budget allows, what is left of the budget goes to the parts that stray furthest, and every part
takes the original's normals; faces no outside view sees are dropped. Base colour is 1024 px for
clothes and hats and 512 px for the rest; each model stays under about 400 KB and all of them under
3 MB. Draco stays off.
