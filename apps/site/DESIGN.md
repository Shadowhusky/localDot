# localdot.dev — design

The site opens inside localDot. A visitor lands in the app itself, picks one of dot's real tasks
and watches it play. Scrolling steps out of the app: the camera pulls back, the app becomes the
screen of dot's own computer, and dot floats out of it to introduce itself and walk through what
localDot does. It ends with the install command.

## Brief

What the owner asked for, in their words:

- Feel like being in the app, customised to be a website; the replays are the demos.
- Demos must be representative and useful or fun, never trivial: long real tasks, clipped and sped up.
- Show the design language, the animation, the mascot and its outfits. Apple-level polish, unique,
  smooth on desktop and on phones. 3D, generated assets and Blender models are welcome.
- No ordinary scroll-down page of text. Scrolling transforms the scene and replaces content: the
  mascot comes to the centre, introduces itself and localDot, and explains the main features and
  why to use it: open source; any model provider; watch the agent work live; preview and export
  replays with lots of options; different dots for different jobs.
- Afterwards, a short promo video goes on the site (its own design, later).
- Later: the first view looked so much like the app that a visitor could take it for a working
  agent. It has to read as a demo of the app, designed as a website.

What this design assumes on top of that:

- Visitors are curious technical people (developers, tinkerers, AI users) on a laptop or a phone.
  Success is that within one minute they have seen dot do a real task, met dot, and know how to
  install it.
- Dark, like the app. The app has a light theme, but the site keeps one cinematic dark look.
- dot speaks in the app's own voice rules: first person, plain, short, no exclamation marks.

## What makes it ours

- The demo is the product, not a picture of it: the app's own chat rows, plan strip, step list,
  tokens and type, fed by recorded sessions, shown as a window on the website.
- dot is the narrator. It is the same character as in the app: the same porcelain body, capsule
  eyes, engine (`apps/web/src/dot/engine`), voices (`apps/web/src/dot/voices.ts`) and outfits.
- The xenon cyan glow means one thing everywhere: dot has control of its computer.
- One continuous space. Nothing scrolls past; the camera moves and the scene changes in place.

Avoided on purpose, because they read as generated: tracked all-caps eyebrows, numbered section
markers, one word accented in a headline, "A · B · C" meta strings, "WORD — fragment" labels,
arrows appended to links, identical feature cards, fade-up-on-every-section.

## Experience

One sticky full-viewport stage (`100lvh`) inside a tall story container. Scroll position maps to
story progress; each chapter owns a range. Everything is a pure function of progress, so scrolling
back reverses it exactly. Copy lives in the DOM in reading order.

### 1. The demo (hero, not pinned)

- The page opens as a website: its own bar (wordmark, the story's places, Get localDot) and a
  headline, "An AI with a computer of its own.", with "Below are replays of real tasks dot did, sped
  up. Pick one to watch." Under them the app sits in a window in the studio, rounded, with a hairline
  and a soft bezel. It is laid out at the window's size, not scaled, so its text is as crisp as in
  the app. A tablet on its side keeps the rail beside the stage; a small phone drops the subheading;
  a phone on its side drops the headline.
- In the window, the app's top bar has its wordmark, the replayed task's title marked "Replay", and
  Watch/Replay. Desktop: the Theatre plays the demo, dot sits docked under it with its caption, and
  the rail has Chat and Activity. Phone: the app's phone layout, without its top bar.
- Nothing pretends to take a request. Where the composer would be, a one-line note says "A replay.
  A real task with DeepSeek Flash, sped up." The top bar has Get localDot.
- The page opens still on the app as it starts: the empty chat greets the visitor in dot's voice
  for their time of day and offers the demos, each with the dot that did it. Nothing plays until
  one is picked, so the window never changes under the visitor. The story shows a task at work from
  its Watch chapter, so reaching it without picking starts the first; a page reopened a little way
  down stays still.
- Choosing a demo shows its request as the conversation's first message; dot listens a moment, then
  steps stream in, the plan fills and the Theatre plays. The docked dot stays in its own skin with
  its own face, following the work with its eyes. It ends on a result card: the task's files with
  their real previews, moments from the recording that replay from that point, and the next demos
  to try.
- A link to a chapter far down the page fades the stage out, cuts there and fades back in, instead
  of playing the whole story past on the way.
- Honest labels: the Theatre's island says "Replay" with the speed of each part (for example 8×);
  the time and cost are the task's own.

### 2. Step out — "Hi, I'm dot."

- The headline fades; the window shrinks and tilts back into a screen floating in the dark studio
  while it keeps playing. In the scene the window is the screen's plane, and the camera starts just
  far enough back that the plane lies on the window.
- dot hops out of its dock, arcs toward the camera, grows, and settles at the centre, looking at the
  visitor (eyes follow the pointer, or tilt on phones).
- Copy: "Hi, I'm dot." then "I do real work on a computer of my own, right on yours."
- Pressing dot makes it react and say another of its lines.

### 3. Watch me work

- The screen comes back beside dot as its monitor, and dot watches it work.
- Copy: "Watch me work." / "Live, from your laptop or your phone. You see every click and keystroke
  as it happens." Then "Step in any time." with a "Take control" control that turns the xenon glow
  off and gives the pointer to the visitor; dot shows its your-turn face.
- As those words come, dot's game comes to its screen: the replay speeds through dot's work to it
  (up to 16 times, easing off to land), or winds back through the game if it has passed it, and
  from another task the screen crossfades into it; the island says which. While the visitor reads,
  dot plays on, winding back before its game is won. With reduced motion the game waits as a still.
- Take control and the paused frame becomes the game, inside the page dot built: its panel takes the
  visitor's paddle and carries on dot's game, its bricks, score and lives, with dot as the ball in
  flight; a finished game racks a new wall in the same panel. The pointer anywhere on dot's screen
  moves the paddle, and the arrow keys, Space, P and R work as the page says. "Hand back" fades the
  game into the recording, which plays on. Anywhere else their pointer shows on dot's screen and
  their clicks land there.
- "You decide how often I ask." with an Ask / Auto / Full access control: dot's face shows how often
  it checks in.

### 4. Any model

- A ring of the twelve best-known provider names orbits dot, tilted so the near side passes below
  it and the far side above; the front one lights up as the ring turns with scroll. More names
  would crowd the near side.
- Copy: "Use any model." / "An API key from any of 25 providers, your ChatGPT or Claude plan, or a
  model running on your own machine." The count comes from `packages/providers` at build time.

### 5. Rewind, then share

- The screen returns in Replay mode; scroll scrubs the task back through its steps.
- The screen gives way to three real clips the app exported from the Breakout recording: with
  captions, with dot in a band under the picture, and with dot in its corner.
- Copy: "Rewind anything." / "Every task is recorded, step by step." Then "Share the good part." /
  "Trim to the moment, speed it up as much as 16 times, add captions, and keep me under the picture
  or in its corner. Then save it as a video."

### 6. A dot for every job

- dot on a turntable. Each beat of scroll sends it into a spin-jump: a crouch, a leap into a full
  turn that springs a little past and settles, the outfit changing halfway round, facing away, and a
  squash as it lands. A new dot chosen mid-turn carries on to the next whole turn, so every dot
  lands facing the visitor: Coder (hoodie), Researcher (mortarboard, round glasses), Finance
  (suit), Video editor (headphones, mustache), Designer (beret, scarf). Each sums itself up in its
  trade's oldest line ("It works on my machine.", "Citation needed.", "Voilà. C'est magnifique."),
  in the tongue that suits it; its skills are listed. The studio takes on each dot's colour.
- Then all six stand in a row: "Pick yours." Accessories (cap, shades, bow, star) can be tried on,
  and every dot in the row wears the choice.

### 7. Yours

- Copy: "Open source, and yours." / "MIT licensed. The app, my computer and every recording stay on
  your machine, and your keys live in a local vault."
- dot pins on its star next to the GitHub link.

### 8. Get localDot

- The install card: macOS, Windows, Linux, the copy button, the install guide. dot greets it with
  happy eyes and a hop. On a phone the command wraps so all of it can be read before running it.

### Film

- "Watch the film" in chapter 2 and "play the film" in the line above the window open the film in a
  sheet over the page. Its video is made only then, so the page never loads it.
- The film is 37 seconds on a 120 bpm score, one bar to two seconds; its cuts, outfit landings and
  big moves land on the beat. dot drops in, turns to where its words will be and says hello on the
  beat; the app arrives and dot shrinks into its dock as it comes;
  five one-second cuts show the demos, each gliding in over the last on the beat while dot's line
  beside it names it, word by word out of a blur, as the titles come; Step in has the visitor's
  cursor ride the game's paddle, so the game answers it; the models orbit dot; each job's dot
  arrives with a spin-jump that lands on the beat in a soft flash and sparkles; the line-up waves
  from the left and smiles together; a rewind leads into the replay; Share comes one thing at a
  time: its words, then Save, which the cursor presses on the beat, filling it to Saved; that click
  sends the clip out of the Theatre as the app dims, and it lands with the shutter and deals itself
  into its three export looks a beat apart, each lower and further back so the part where they
  differ shows, and they hold to be read; and the name lands on the last hit.
- The film has a Chinese cut, rendered from the same composition, for the Chinese page.
- It uses the site's own 3D dot, lit and shaded as on the page, so the two always match.

## Places

- The address names the beat the story is at (`#hello`, `#watch`, `#step-in`, `#ask`, `#models`,
  `#replay`, `#share`, `#dots`, each dot's own, `#pick`, `#yours`, `#get`), updated in place as the
  visitor scrolls, never adding to the history.
- Opened at a place, by a reload or a shared link, the page lands on that beat at once, where its
  words show whole; the story never plays down to it, and the browser does not restore the scroll
  itself. The bar's links and the app's own links go to the same places: one close by is scrolled
  to, one further off is cut to with a quick fade.

## Languages

- The page reads in Simplified Chinese for a visitor whose system is set to Chinese, and a toggle in
  the bar, 中文 or EN, switches it; the choice is remembered in the browser and named in the address
  (`?lang=zh`), so a link carries it. The language is chosen before
  the first paint, and the words wait hidden until they are in it, so no English shows first.
- The Chinese is written for Chinese readers rather than carried over: dot introduces itself and
  talks to the visitor in everyday words (做个攻略, 派活, 调 bug, 抖音要竖屏, the coder's
  废话少说，放码过来), not a feature list. Headlines break between phrases, not inside them, and their full-width commas
  close up, as display type sets them. The designer keeps its French.
- The replays, and the app inside them, stay as recorded, in English; their speed notes, the
  island's labels and dot's own lines around them are translated. Traditional Chinese readers get
  the Simplified page.

## Design language

Tokens come from the app (`apps/web/src/ui/tokens.css`, `theme.css`); the site adds only its own
layout and display type.

- Colour: the app's void and raised surfaces, pearl `#eceef0` for dot, xenon `#3fb5de` for control.
  The studio is a deep blue-black gradient with a soft floor pool of light. Outfits bring the only
  other colours.
- Type: the system UI face, as in the app (SF Pro on Apple devices). Display sizes are tight
  (`-0.03em`, line-height 1.02); body text stays at the app's sizes.
- Motion: critically damped springs for UI; dot's engine for the character; scroll smoothing with a
  damped follower, never scroll hijacking. One orchestrated move per chapter.
- Voice: dot speaks for itself. Feature names are what users see in the app.

## The 3D

- One WebGL renderer (Three.js), one camera, transparent clear colour, `pointer-events: none`,
  layered over the HTML app. Neutral tone mapping, sRGB output, DPR capped at 2 (1.5 on low-power).
- dot: the body is a sphere of radius 1 with the plates' porcelain look; each wearable is a GLB
  exported from the same Blender scripts as the plates (`tools/dot-plates/export_glb.py`) with its
  base colour, normal and occlusion/roughness/metalness maps, plus the shade it casts on the body,
  baked into the body's longitude/latitude texture. The body reads the shade of what sits on the
  face (glasses, mustache) where the face is, so it turns with them as dot looks around. Glasses
  are frames without arms, as in the plates, and their clear lenses blend rather than transmit. Environment light is a prefiltered environment
  of the plates' light panels (`plates.json`), and a key, fill, rim and top light ride with the
  camera, centred on dot, so dot is lit from its portraits' angles from wherever and however far
  away it is seen.
- Eyes: the body's shader paints them as signed distance fields from the app's eye geometry, driven
  by the app's `DotEngine` pose (lids, arch, tilt, happy, closed, gaze, blink), so dot emotes exactly
  as in the app. Gaze turns the face, and the glasses and mustache turn with it.
- The plates are drawn by an orthographic camera; a perspective camera close to dot looks up at its
  hats. dot's head tips its top toward the camera by that angle, its face still looking at the
  camera, so hats read as in the plates. The turntable turns about that tipped axis.
- The app screen in 3D: the HTML app is transformed with a CSS `matrix3d` that matches a plane in
  the scene; the WebGL layer punches a transparent hole there, so the live app shows through and dot
  can pass in front of it. At rest the transform is removed so text stays sharp.
- Provider ring: provider names are HTML positioned from the ring's 3D points.
- Fallback without WebGL: the app's 2D DotView with its plates, and the chapters as plain sections.

## Demos

Five new tasks, each by the dot made for it, run for real on a separate demo computer with
invented data or public sources, then cut and sped up:

| Demo | Dot | Task | Result shown |
|---|---|---|---|
| Breakout | Coder | Build a Breakout game in Vite + TypeScript where the ball is dot, run it, play a round | The game, playable on the site |
| Kyoto | Researcher | Plan three autumn days in Kyoto from public sources, with fees, hours, map links and a budget | The itinerary PDF |
| Spending | Finance | Turn six months of an invented card export into a budget workbook with formulas, charts and flags | The workbook and takeaways |
| Poster | Designer | Design a gig poster for an invented jazz night; export A3 PDF and an Instagram PNG | Both exports |
| Teaser | Video editor | Cut a 20-second vertical teaser from Big Buck Bunny (CC BY 3.0) with captions and credit | The teaser |

Recording rules: a demo computer of its own; a new conversation per demo so no earlier chat reaches
it; the persona switched only while the task starts, then the owner's settings restored; a spending
cap per task; nothing personal on screen. Every published line of text is reviewed.

Bundle per demo in `public/demos/<id>/`: `theatre.mp4` (the app's own export of the Theatre, with
pointer and click marks, at the chosen speed per segment), a lighter `theatre-sm.mp4` for phones,
`poster.webp` and `timeline.json` (pruned events, cuts, speeds, model, persona and cost). The
results dot handed over, with their previews and the recording's proof moments, are in
`public/file-previews/<id>…/`, where the app's file viewer looks for them. The site feeds the
timeline through the app's reducer and renders the app's own rows. `scripts/demo-bundle.ts` builds
bundles from a private configuration kept in ignored `qa/`; `scripts/record-demo.mjs` records one.

## Architecture

- `apps/site`: Vite, TypeScript, React for the hero app, Three.js for the scene. App code is
  imported from `apps/web/src` and `packages/*` through aliases, deduplicating React, so the site
  shows the current app.
- `src/hero`: the app replica (top bar, Theatre, chat rail, demo player).
- `src/dot3d`: the 3D dot (model, eye material, pose mapping, outfits).
- `src/scene`: renderer, studio, the app's screen in 3D, provider ring, export clips, line-up.
- `src/story`: scroll director (smoothed progress, chapter ranges, keyframe tracks) and copy.
- The Worker keeps the canonical-host redirect and gains byte ranges for the demo files and the
  film, cut from the stream with the length the asset binding sends, or the build's record of it
  (`media-lengths.json`) when it sends none.

## Access and fallbacks

- Every chapter's text is a real heading and paragraph in reading order; controls are buttons with
  visible focus and 44 px targets; nothing depends on hover.
- Reduced motion: no camera travel or scrubbed motion; chapters cross-fade; dot blinks and looks.
- Without JavaScript: the story reads as sections, the demo is a native video, the install command
  is visible.

## Budgets

- First view: HTML, CSS and the hero chunk under 300 KB compressed; the first demo's poster at once,
  its video streamed. The 3D chunk and models (under 2 MB) load after first paint.
- 60 fps on recent laptops; no worse than 50 fps on a recent iPhone. Under 60 draw calls.
- The renderer pauses off screen and in hidden tabs.

## Verification

Playwright in Chromium and WebKit at 1440×900, 1280×800, 1024×768, 768×1024, 390×844, 375×667 and
844×390: the page opens still, the first demo plays when picked, every chapter at several progress
points shows its words inside the screen, nothing overflows and nothing logs an error. Also reduced motion, no JavaScript, and
an axe WCAG 2.2 A/AA scan on a desktop and a phone. Frame timing is measured and recorded in
`QUALITY.md` with what was not measured.
