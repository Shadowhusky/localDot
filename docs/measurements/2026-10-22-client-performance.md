# Client performance while watching a task

2026-10-22 · Mac Studio, Apple M3 Ultra (28 cores), 96 GB, macOS 26.6.2 · Playwright 1.63.0's
Chromium headless shell (HeadlessChrome 153) with `--enable-gpu` (ANGLE on Metal) · base
`a9a55ef7` (v0.1.0-rc.32) against the same tree with the changes below.

The owner's report: watching the stream overloads a MacBook Pro, and typing on an iPhone sometimes
sticks. These runs measure the page, not the computer: the fixture daemon plays a busy task and a
synthetic stream into the real app.

## Method

- `apps/web/e2e/ui/perf-live-run.spec.ts`: the `running` scenario, then `POST /__qa/live-run`
  (fixture route): dot flips between thinking and acting every 300–600 ms, takes a step per turn
  with a screenshot (every third a shell command), streams a sentence every other turn, sends a
  heartbeat each second and runs two helpers. 30 s of watching are measured, then 40 characters
  are typed into the composer at 120 ms a key while the run goes on.
- `apps/web/e2e/ui/perf-stage.spec.ts`: the stage alone, fed by `streamDesktop` (`e2e/ui/perf.ts`),
  a stand-in for Selkies' client that decodes H.264 on the GPU into a track generator its video
  plays, so the stage taps it as it taps Selkies'. It follows the frame rate the viewer asks for,
  as the daemon sets the capture's, and pauses on `STOP_VIDEO`.
- Desktop: 1440×900 at 2× (a MacBook's display). Phone: 390×844 at 2×, touch, with the CPU
  slowed four times (`Emulation.setCPUThrottlingRate`) for the live run.
- Counts: React commits through a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` (Theatre renders and
  components rendered per commit from the fiber flags), rAF frames, long tasks, Event Timing
  (keydown/input events of 16 ms or more; the rest count as under 16 ms), CDP
  `Performance.getMetrics` deltas (style recalcs, layouts, task time, thread and process CPU),
  `SystemInfo.getProcessInfo` (GPU process CPU), status reads (`GET /api/agent/sessions/:id`), and
  in the render worker its display-frame callbacks, scene looks, canvas draws and frame uploads.
- Before and after alternate, three rounds each (`QA_UI_DIR` serves the before build), and the
  tables give medians. Other agents' builds and tests ran on the machine throughout; the
  load averages are listed. Counts (commits, renders, looks, uploads, recalcs and layouts per key,
  reads per minute) hardly move with load; CPU percentages and task times do.

Reproduce from `apps/web` after `pnpm build && pnpm build:gallery`:

```sh
QA_PERF_OUT=/tmp/perf.jsonl pnpm exec playwright test --config playwright.ui.config.ts \
  --project=c14 --project=c39 --workers=1 perf-live-run perf-stage
```

## Results

Medians of three interleaved runs each. 1-minute load averages while they ran: 36–64 before,
19–60 after (one before run shared the machine with a unit-test run).

### Watching a busy task, then typing

| | Desktop before | Desktop after | Phone (4× slower CPU) before | Phone after |
| --- | ---: | ---: | ---: | ---: |
| React commits / s | 18.4 | 14.5 | 7.8 | 6.8 |
| Theatre (the whole page) renders / s | 9.3 | 5.2 | 5.8 | 3.1 |
| Components rendered per commit | 145 | 50 | 99 | 62 |
| Status reads (`GET /api/agent/sessions/:id`) / min | 171 | 62 | 133 | 62 |
| rAF frames / s | 54.1 | 59.7 | 10.7 | 20.9 |
| Long tasks in 30 s (count, total) | 9, 0.54 s | 0, 0 s | 205, 16.2 s | 101, 7.7 s |
| Style recalcs / s, layouts / s | 70 / 51 | 66 / 51 | 17 / 14 | 24 / 19 |
| Main-thread tasks, ms / s | 556 | 380 | 972 | 971 |
| Main thread / renderer / GPU process CPU % | 30 / 54 / 58 | 21 / 40 / 42 | 64 / 83 / 26 | 57 / 76 / 28 |
| Style recalcs per key, all (less the run's own) | 12.8 (2.4) | 10.3 (1.8) | 5.4 (0.9) | 5.7 (1.1) |
| Layouts per key, all (less the run's own) | 9.5 (2.1) | 8.5 (1.7) | 4.3 (0.6) | 4.4 (0.8) |
| keydown p75 / max, ms | 48 / 64 | 48 / 64 | 96 / 256 | 56 / 192 |
| input p75 / max, ms | 40 / 56 | 48 / 56 | 56 / 216 | 40 / 160 |

The phone's main thread stays busy throughout at a quarter of this Mac's speed, so its rates are
bounded by the frames it manages: it now draws twice as many frames, and its style recalcs and
layouts per frame fell from 1.6 and 1.3 to 1.2 and 0.9. Its long tasks halved and its slowest key
press dropped from 256 ms to 192 ms. On the desktop the main thread no longer has long tasks.

### The stage

Desktop at 1440×900 at 2× (the stage is 1024×640, 51 % of the window; full screen 1242×776,
74 %), phone at 390×844. Before → after.

| Case | Asked/used fps | Worker looks / s | Draws / s | Frames uploaded / s | Renderer / GPU process CPU % |
| --- | --- | ---: | ---: | ---: | ---: |
| Desktop, running task | 60 → 30 | 60 → 32 | 54 → 31 | 40 → 28 | 55 / 58 → 39 / 38 |
| Desktop, running task, full screen | 60 → 60 | 60 → 60 | 55 → 58 | 46 → 54 | 42 / 38 → 33 / 39 |
| Desktop, still task, stream fixed at 30 fps | — | 60 → 31 | 29 → 29 | 29 → 29 | 16 / 28 → 15 / 22 |
| Desktop, still task, stream fixed at 60 fps | — | 60 → 56 | 52 → 56 | 52 → 56 | 21 / 47 → 21 / 42 |
| Phone, running task | 30 → 30 | 60 → 33 | 50 → 31 | 27 → 27 | 45 / 49 → 38 / 45 |
| Phone, running task, screen minimised | 30 → none | 60 → 0 | 49 → 0 | 27 → 0 | 41 / 36 → 29 / 17 |

- The worker's display-frame callbacks stay at 120 a second (headless Chromium's worker frame
  rate), but most now return at once: looks, which build and key the scene, and draws follow the
  stream's rate. A frame waiting to be drawn still goes at up to 60 Hz, so a stream fixed at
  60 fps keeps 56 draws a second, now with less GPU time per draw (no multisampling, 1.5× pixels).
- Full screen asks for 60 fps as before and keeps up better (53 frames shown a second, was 47).
- The island's glass, measured on the before build with and without its blur: 58 → 53 % GPU
  process CPU under a running task, 38 → 36 % in full screen. The after build has no blur while
  the stream is live, so its two cases match.
- Selkies' client is not measured here (its JS and H.264 come from the cell); its assets now load
  once from the browser cache rather than on every new ticket.

## What changed

- Stream and stage: a stage in part of the window asks for 30 fps; full screen, a stage covering
  60 % of the window or more, and the user's control keep 60 (`stream-quality.ts`, `Stage.tsx`).
  The render worker looks at most at that rate and never above 60 Hz, a waiting frame at most at
  60 Hz (`render-worker.ts`). The canvas has no antialiasing and at most 1.5× backing pixels
  (`pixi-presenter.ts`, `stage-engine.ts`).
- Out of sight: an IntersectionObserver and the canvas's size tell the stage when it is scrolled
  away, clipped (the phone's minimised screen) or has no size; `Stage`'s `covered` prop takes the
  rest (the App passes the minimised screen and a phone's full-height Settings). The stream then
  stops its video (`STOP_VIDEO`, `visible: false`) and its tap, the worker stops drawing, and the
  client stays: the picture returns with a key frame (`live-stream.ts`).
- A hidden tab keeps its client with the video stopped for up to a minute; after that, when
  Chrome freezes the page, or when it returns after a minute away (iOS runs no timers), it takes a
  fresh client as before.
- The Selkies client's hashed files are served once at `/selkies/assets/` with immutable caching;
  only its page, cell API and socket stay under the ticket (`stream-proxy.ts`).
- The island and its notes are solid glass while the stream is live (`hud.css`).
- Page renders: live-session updates are a transition, at most four a second on a touch device or
  while the composer has focus; heartbeats no longer redraw the page; dot moving between
  thinking, acting and observing no longer re-reads the task's status (`useLiveSession.ts`,
  `reducer.ts`). The hidden Activity and Routines panels and closed Settings and Routine sheets
  sit out the page's renders (`Held`). Settings validation is memoised, media query lists and date
  formatters are made once, and the platform check is cached.
- Layout: dot measures the composer and its place once a frame instead of on each key and
  transition end, the computer-keyboard check no longer reads the viewport on every render, and
  `--_visible-h` and `--_visible-top` are registered as not inherited. The mascot's calm frame
  interval is 110 ms (was 33).

## Second pass

Base: the integration branch on `a9a55ef7` with the first pass, dev-server previews, several dots
and a polish batch (before), against the same tree with the changes below (after). Same harness;
the live run's probe also counts the mascot's prop drawings (each clears its front layer first).
Medians of three interleaved runs each, on a quiet machine this time (1-minute load 3.6–7.7), so
CPU and task times are not comparable with the first pass's table; the counts are.

| | Desktop before | Desktop after | Phone (4× slower CPU) before | Phone after |
| --- | ---: | ---: | ---: | ---: |
| React commits / s | 14.9 | 15.0 | 13.7 | 14.1 |
| Theatre (the whole page) renders / s | 5.1 | 4.2 | 4.3 | 3.4 |
| Components rendered per commit | 49 | 25 | 44 | 23 |
| Mascot prop drawings / s | 47 | 47 | 48 | 50 |
| rAF frames / s | 60 | 60 | 60 | 60 |
| Style recalcs / s, layouts / s | 67 / 52 | 67 / 52 | 66 / 52 | 66 / 53 |
| Main-thread tasks, ms / s | 83 | 81 | 293 | 295 |
| Main thread / renderer / GPU process CPU % | 8 / 18 / 17 | 8 / 18 / 17 | 84 / 93 / 18 | 84 / 93 / 18 |
| keydown p75 / max, ms | 48 / 48 | 48 / 48 | 48 / 48 | 32 / 32 |
| input p75 / max, ms | 48 / 48 | 48 / 48 | 40 / 48 | 24 / 32 |

- Commits draw half as many components, and the page renders a fifth less often. Walking the
  fibers of an unminified build during the live run, a desktop page render drew about 140
  components before the memo boundaries (rail 78, stage frame 37, top bar 19) and 85 after (rail
  39, stage frame 37, top bar 0); the phone's went from about 143 to 87. Commits stay at about 15
  a second: most are the small ones of a message's new words and of the timers that now count by
  themselves.
- Typing on the phone got faster (key p75 48 → 32 ms), but the main thread's time hardly moved:
  React was not most of it. About one style recalc and one layout a frame remain.
- The mascot's drawings did not change here, because in the live run it sits at 96 px (desktop)
  and 80 px (phone), the "glance" size that keeps 30 fps loops, and dot's turns every 300–600 ms
  keep it in transition, which draws every frame. As an experiment (not kept), drawing its
  transitions at 30 fps too halved its drawings (47 → 25 a second) and cut layouts by a third
  (51 → 32), with main-thread time within noise and a visibly less fluid dot at that size.
- CSS animations run throughout a task: the live line's shimmer (`thread-shimmer`) and spinning
  glyph (`ui-spin`), and on the desktop a skeleton sweep (`ui-skeleton-sweep`). The third pass
  shows they are not what restyles the page each frame.

### What changed

- A leaf clock. Theatre reads the session's time again only when what it shows may change by
  itself: once the moment after its latest event has passed (1.3 s, the longest of the
  past-tense label, a wince, a finished step and a helper leaving), at a retry's deadline and
  when a long thought turns into its own line (`useNowMs`, `nextChange`). The island's and the
  decision sheet's timer (`TaskTime`), the live line's time and the Activity row of the step
  under way (`RunningTime`) and research's minutes count by themselves from `SessionNowContext`.
  The stalled check fires once, when the last heartbeat turns 1.5 s old (`useTaskStalled`).
- The mascot's tool loops draw at 20 fps at the dock's size (`presence`, 33–72 px); larger sizes
  keep 30, and a recording's dot in Replay keeps 30 at every size (`DotView.setFullRate`). Export
  paints the dot from the engine's poses, so its frames are unchanged.
- Memo boundaries. The agent view keeps its identity while nothing in it changed
  (`useAgentSession`). The composer is memoised on what it reads of the task and the computer, as
  dot's words, steps, usage and heartbeats change many times a second, and Theatre hands it stable
  handlers (`useHandler`) and memoised model and permission chips and Stop action. The live work
  line is memoised on what it draws and keeps its clock in a leaf. The top bar's elements and
  handlers are stable, so the memoised `TopBar` no longer draws with the page. `ChatThread` is
  not memoised: its rows and agent view change with nearly every page render during a task, so
  its costly children skip instead.
- Incremental rows. `stepRows` keeps a step's view while it is unchanged, and `timelineRows`,
  `activityRows` and `workSteps` keep what they built from it, so a page render builds only the
  steps that changed.
- `--_composer-bottom` is written on the toolbar that reads it and `--_composer-rest-height` on
  the dock, both registered as not inherited, so the keyboard's moves restyle those two only.
- Budgets: at most 8 page renders a second on the desktop and 5 on the phone, and 40 components
  a commit (`perf-live-run.spec.ts`).

## Third pass

Base: the merged second pass (before), against the same tree with the changes below (after).
Medians of three interleaved runs each; 1-minute load 3.5–6.3.

| | Desktop before | Desktop after | Phone (4× CPU) before | Phone after |
| --- | ---: | ---: | ---: | ---: |
| Style recalcs / s, layouts / s | 67 / 51 | 67 / 51 | 66 / 53 | 66 / 53 |
| Style, layout ms / s | 14.9, 2.7 | 18.1, 3.1 | 74.7, 14.4 | 86.2, 14.5 |
| Main-thread tasks, ms / s | 88 | 93 | 351 | 355 |
| keydown p75 / max, ms | 32 / 32 | 16 / 16 | 48 / 48 | 32 / 48 |
| input p75, ms | 32 | 16 | 40 | 32 |

- Every loop now runs on the compositor. A trace of the live run (`blink.animations`) showed the
  spin failing to composite ("SVG target has an independent transform property": `rotate` on an
  svg), and the shimmer and the skeleton sweep animating `background-position`. In the after
  build, the only animation left on the main thread is the scroll edges' short
  `--ui-fade-top` transition.
- The background cost did not fall: the page still restyles and lays out about once a frame.
  The same trace puts most of the layouts on the mascot, whose eyes are svg attributes set on
  each frame it draws (`renderEye`, about 40 a second), and the rest of the recalcs come
  without a script stack. With every animation disabled outright, the phone's style time fell
  from 78 to 47 ms a second, but the recalcs only from 66 to 58 a second. Most of that saving is
  in the short entrance and exit animations, which stay. Style time per second was 2–3 ms higher
  on the desktop in two separate series (within noise on the phone).
- A key press reaches the screen sooner, as the frame it waits for no longer repaints the line
  and the spinner: desktop p75 32 → 16 ms, phone 48 → 32 ms.

### What changed

- The live line's light is the line again in the brighter colour, under a masked band that moves
  while the copy inside it moves back as far, both by `transform` (`.thread-work-glint`, its text
  from `data-text`). It keeps the look: frames captured at the same moments differ from the old
  gradient by about one level on average (out of 255), at glyph edges. It is hidden under
  reduced motion and in forced colours, as the gradient was.
- `ui-spin` turns by `transform` rather than `rotate`, so the svg spinners, status glyphs and
  rings composite.
- Spinners, status glyphs, progress fills and skeleton bones pause while their view is hidden
  under another one: Activity, Routines or the covered thread. On the desktop the hidden
  Routines panel's skeleton swept throughout a task. The skeleton keeps its `background-position`
  sweep, as its one sweep across all the bones on the page (`background-attachment: fixed`) has
  no composited equivalent.
- After Replay the stage reconnects and its curtain lifts for 0.5 s. The idle line took either
  for a task and dropped its greeting for a turn. It now keeps its line while only the picture
  is on its way (`pictureAway`: connecting, reconnecting or suspended) and while the curtain
  lifts.

## Not done here

1. **The mascot draws every frame** during a task, setting svg attributes that lay out the page;
   drawing its transitions at 30 fps (measured in the second pass) is a design call.
2. **The stage frame** (island, narrator band, work view, stage controls) still draws with each
   page render, about 37 components each time. Its inputs change with the task's events, so it
   would need comparators like the composer's. The phone's toolbar elements (More menu, Activity
   button, about 7 components) could be kept as elements.
3. **Forced reads on scroll and mutation.** `useFollowScroll`'s hold (a MutationObserver reads the
   scroll height on each change) and `ScrollArea`'s edges were 2–4 % of the phone's samples.
   Holding once a frame changes the timing the follow-scroll tests pin down, so it waits for that
   hook's owner.
4. Not measured: an iPhone's WebKit and a ProMotion display. The harness runs Chromium; the
   render worker's looks are counted against a 120 Hz frame source, which headless Chromium gives
   its worker.
