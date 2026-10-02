# localDot main window: three visual directions

This is the UI direction gate for M2. Each file is the 1440×900 app window in **Watch** mode, mid-task: dot is typing into LibreOffice Calc for the task "Put last quarter's revenue from the report into a sheet". The scene, copy and overlay semantics are the same in all three. Only the chrome and the overlay styling change.

| Direction | File | Screenshot (1440×900 @2x) | Accent |
|---|---|---|---|
| A: Studio | `a-studio.html` | `a-studio.png` | Proof magenta `#CC1F59` |
| B: Control Room | `b-control-room.html` | `b-control-room.png` | Tally red `#F23B3B` |
| C: Theatre | `c-theatre.html` | `c-theatre.png` | Xenon `#3FB5DE` |

`stage.png` is the real 1280×800 capture from spike S2 (`step6-3-cursor-off.png`), left unchanged.

## A: Studio

localDot is a tool you supervise, the way an editor supervises a take in a pro app. Studio makes the chrome a quiet, light workbench: cool neutral greys, hairlines and macOS-grade controls. The virtual computer sits in it as a dark inset monitor, so the machine being driven is the only thing with depth and contrast. Everything the agent does is drawn in one proof magenta. Print and design tools reserve that colour for marks that sit on top of the work and never belong to it (Illustrator's smart guides, for example). That is exactly what these overlays are: viewer-only annotations, never pixels in the VM. The result looks precise and trustworthy rather than magical, which suits a local open-source tool that people leave running on their own machine.

**Accent reason.** Desktop apps almost never use magenta for their own selection or focus; they use blue. That means the agent's target box can't be mistaken for the app's selection. Calc's own blue cell cursor on A1 sits right next to the agent's box on B2. The hue is about 340°, clearly rose-red rather than violet.

| Token | Value | Role |
|---|---|---|
| `--window` | `#ECEDF0` | Toolbar and window background |
| `--panel` | `#F6F6F8` | Conversation and inspector columns |
| `--raised` | `#FFFFFF` | Cards, input, active segment, pill |
| `--sunken` | `#E4E5E9` | Segmented control track, icon wells |
| `--well` | `#E3E4E8` | Floor under the monitor |
| `--bezel` | `#121316` | Monitor bezel |
| `--line` / `--line-strong` | `#D9DADF` / `#C6C8CE` | Hairlines |
| `--text` / `--text-2` / `--text-3` | `#1A1B1F` / `#5C5F68` / `#8C8F98` | Type ramp |
| `--text-well` / `--text-well-2` | `#3F424A` / `#7A7D86` | Monitor footer |
| `--accent` | `#CC1F59` | Agent control, target, cursor stroke, ring, caret, current step |
| `--accent-ink` | `#FFFFFF` | Text on accent |
| `--accent-a10` / `--accent-a35` | `rgba(204,31,89,.10)` / `.35` | Target fill, control glow |
| `--hud` / `--hud-text` | `rgba(26,27,31,.90)` / `#F4F4F6` | Chips and keycaps over the video |
| `--cursor-fill` / `--cursor-rim` | `#FFFFFF` / `#16171A` | Agent cursor |
| `--avatar-body` / `--avatar-eye` | `#1A1B1F` / `#FFFFFF` | Mascot |

Shadow tokens (`--shadow-*`, `--shade-*`, `--edge-*`, `--key-bevel`) are neutral black or white alphas.

## B: Control Room

Watching an agent act is a live broadcast: something is happening now, on a machine you can't touch until you cut in. Control Room borrows the gallery's instrument discipline. It has graphite panels, flat modules, and telemetry you can audit: wall-clock timestamps, per-step durations, frame rate and latency. It also adds a timeline that separates acting from thinking. The tally light is its only colour. In a studio, the red tally tells everyone which camera is on air. Here it tells you the agent holds the controls. It lights the frame around the program monitor, the "dot has control" tag, the live lamp, the current plan item and the current step. When you take over, the tally goes out. This direction suits people who want to audit the run, not just watch it.

**Accent reason.** "Red tally = live" is an old, instantly readable convention, and it maps one-to-one onto "the agent has control". Red is spent only on that state. Stop stays neutral so red never gets a second meaning like "danger".

| Token | Value | Role |
|---|---|---|
| `--bg` | `#1A1C20` | Top bar, app background |
| `--panel` | `#1F2226` | Side columns, timeline |
| `--raised` | `#272A30` | Cards, status pill, active segment |
| `--inset` | `#121417` | Monitor wall, input, avatar tile |
| `--line` / `--line-2` | `#2D3137` / `#3B4047` | Module rules |
| `--text` / `--text-2` / `--text-3` | `#E8EAED` / `#A2A7AF` / `#6C727B` | Type ramp |
| `--tally` | `#F23B3B` | Agent control, live lamp, brackets, cursor stroke, ring, caret, current step |
| `--tally-ink` | `#FFFFFF` | Text on tally |
| `--tally-a12` / `--tally-a22` / `--tally-a45` | `rgba(242,59,59,.12/.22/.45)` | Live block fill, lamp halo, glow |
| `--hud` / `--hud-line` | `rgba(19,21,24,.94)` / `rgba(255,255,255,.12)` | Chips and keycaps over the video |
| `--cursor-fill` / `--cursor-rim` | `#FFFFFF` / `#141619` | Agent cursor |
| `--avatar-body` / `--avatar-eye` | `#E8EAED` / `#1A1C20` | Mascot |

## C: Theatre

Most of the time you just want to see the work happen. Theatre dims the house: a near-black surround, no panel surfaces, and chat and steps set in quiet grey type at the edges. The virtual computer floats large and lit at the centre. The narration also plays as a surtitle under the stage (the spec's caption layer), so you never look away to follow along. The status HUD sits on the picture itself. The only colour is xenon, the cool blue-white of a follow-spot tracking a performer. It rims the stage while dot holds control and marks the target, the cursor and the click. This is the calmest direction and the one that most directly sells "shows exactly what it is doing".

**Accent reason.** Xenon behaves like a light rather than a hue. It is cool, so it stands apart from warm desktop content. It is much lighter than any desktop selection blue (Calc's is `#145BA6`), so it doesn't read as the app's own focus. One consequence: the research spec's "looking at" teal (`#028391`) would sit too close to it, so Theatre would draw "looking at" as a neutral dashed outline instead.

| Token | Value | Role |
|---|---|---|
| `--void` | `#0A0B0D` | The house |
| `--surface` / `--surface-2` | `#15161A` / `#1D1E23` | Input, file card, user bubble |
| `--line` | `#25272C` | Rules |
| `--text` / `--text-2` / `--text-3` | `#EEEFF1` / `#999CA4` / `#5D6068` | Type ramp (the rails default to `--text-2`) |
| `--xenon` | `#3FB5DE` | Agent control rim, target, cursor stroke, ring, caret, current step |
| `--xenon-a08` / `--xenon-a40` | `rgba(63,181,222,.08)` / `.40` | Target fill, rim glow |
| `--hud` / `--hud-solid` / `--hud-line` | `rgba(14,15,18,.74)` / `.92` / `rgba(255,255,255,.10)` | Status HUD (blurred), chips |
| `--edge` | `rgba(0,0,0,.55)` | Stage drop shadow |
| `--cursor-fill` / `--cursor-rim` | `#FFFFFF` / `#121316` | Agent cursor |
| `--avatar-body` / `--avatar-eye` | `#ECEDEF` / `#0A0B0D` | Mascot |

## Shared decisions and notes

- **Target geometry.** A pixel scan of `stage.png` puts cell B2 at x 114–196, y 230–247 (the gridlines). The brief's y 213–230 is actually row 1. Overlays are placed in the image's 1280×800 space through a `--s` scale variable and drawn at a constant screen size. The cursor tip rests at (160, 241), inside B2, and the click ring is centred on it.
- **Same overlays, different styling.** A draws a box, B draws camera-style corner brackets, and C draws a box with a dark halo so the light accent still shows on white. The typing pill and the role chip stack above the field. The cursor name chip sits below-right. The fading `Ctrl` `S` keycaps sit at bottom-centre.
- **Status pill placement** is where the three differ most. A sits it on the stage's top edge (Edge style). B puts it top-centre in the window bar. C floats it on the picture as a HUD. C's HUD is the only backdrop blur in the set; it is functional over video and falls back to solid under `prefers-reduced-transparency`.
- **The accent only means "agent has control".** Stop is neutral everywhere, and so are done states. Takeover would switch the frame to neutral or green, per the spec.
- **Mascot.** The mascot is a flat circle with two short eye strokes pushed up and toward the stage. Taller, centred eyes read as a pause icon at 16 px, so the eyes were deliberately shortened and moved off-centre.
- **Type.** All three use the system stack. SF Mono appears only for telemetry and durations: in A, the monitor telemetry line; in B, timestamps, durations and timecode; in C, nowhere (tabular SF instead).
- **B's timeline strip is an addition.** It is the Replay scrubber shown live, with thinking gaps marked. It is optional if B is picked.
- **Known mismatch.** The stage frame is the spike capture, so Calc's title bar still reads "Untitled 1" while the step list says "Saved as q3-revenue.ods".
- **Tried and dropped.** Theatre originally used the spec's focus-dim spotlight (layer 2). On a white document it read as grime, so it was removed.
- Only the caret moves (a CSS blink), and it stops under `prefers-reduced-motion`. No JavaScript.

## Decision

2026-09-30: the user picked **C: Theatre** (`c-theatre.html`, accent xenon `#3FB5DE`). Part 2 builds the main window in this direction. Carry-over notes: draw the spec's "looking at" state as a neutral dashed outline (xenon is too close to the research teal); keep the status HUD on the picture with its solid fallback under reduced transparency; make the chat and step rails comfortable to read at length (the mockup's slim grey rails were the main weakness).
