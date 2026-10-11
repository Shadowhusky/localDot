# A window into dot’s world

Travel from the real app into dot’s space, then back out with a clear understanding of what it can do.
Native scroll owns the story; replay controls, feature choices, and greeting are local interactions.

## Visual and spatial contract

One persistent WebGL renderer. Graph: studio → pearl mascot, floor rings, three beveled task windows,
and a vault. The white spherical mascot follows the app’s identity. No robot substitute.
Near-black #090b0d, pearl #e9ecef, cyan #8cd9ec; cyan means presence/control, never confetti.
Sphere radius .8 world units. Windows 2.4 × 1.55 with .08 bevels. Typography stays in HTML.
System sans, large titles -0.065em tracking, .94 leading. No webfonts, no third-party tracking.
Camera FOV 36°, near .1 / far 60. Desktop copies use the left 50%; models occupy the right.
At widths up to 900px, models occupy the upper area and text sits below. Each chapter has a separate mobile pose. The final chapter hides decorative 3D on short phones so installation controls stay clear.

## Chapters / camera / material ledger

| Chapter | Change / landmark | Camera xyz | Mascot xyz | Mobile mascot xyz | Interaction |
|---|---|---|---|---|---|
| Watch | actual app recording above a dim studio | 0,0,10 | 3,-2,-2 | 0,0,-5 | choose replay, play/pause, seek, fullscreen |
| Hello | close pearl sphere, gaze meets visitor | 0,0,8 | 1.75,0,0 | 0,1.25,0 | greet button, pointer gaze |
| Possibilities | pull back to reveal work windows | .4,.2,10 | 1.9,-.2,.3 | 0,1.4,0 | choose capability; windows respond |
| Yours | turn around sphere to reveal vault | -.5,.1,9 | 2,.35,0 | 0,1.4,0 | choose permission level explanation |
| Get dot | return to close, quiet sphere | 0,0,8.5 | 1.8,0,0 | 0,1.2,0 | choose platform, copy public install command |

Pearl: dielectric, roughness .27, clearcoat .65. Eyes: near black, roughness .2.
Graphite windows: roughness .36, metalness .45; cyan thin accents, no full-screen bloom.
Soft studio key from upper left, cool fill right, no shadow maps or screen-space effects.
Shared geometries/materials. Contact shadow uses a small radial canvas texture. No downloaded models.

## Motion and access

Progress is derived from stable native section offsets; never wheel delta. Opacity, depth, and
rotation share that progress, reversible at every point. Light damping only on camera; semantic
ownership follows exact scroll. Maximum pointer turn .12 radians. No scroll prevention.
Reduced motion removes WebGL, parallax, blur, autoplay and camera travel, retaining every chapter.
No-JS shows the semantic story, poster, native video controls, and anchors. WebGL loss uses stills.
All functions have HTML controls, >=44px touch targets, visible focus, and no hover-only actions.

## Assets and loading

Loading uses the app's actual DotView waking/thinking animation. It follows the critical poster
and initial player, with a continue control; no fake percentage or minimum delay. Three loads
asynchronously and cannot block the demo. Paused/reduced-motion visits don't load Three.
Use purpose-created agent sessions on a separate demo computer, with invented task data or public
sources; never publish personal user sessions. Record actual screen actions, review the selected
footage, and disclose excerpts and playback speed. Do not substitute still-image fixtures for
executed tasks.

Target initial transfer <3MB, later media on selection; DPR <=1.5 desktop / 1.25 mobile,
<50 draw calls, <100k triangles. Pause offscreen/hidden, dispose on pagehide, resume on pageshow.
Live renderer metrics and checked viewport evidence belong in QUALITY.md, not estimated passes.
The packaged installer is public. Installation commands and the public download guide are available in the final chapter.
