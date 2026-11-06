# Website verification — 5 November 2026

The browser check, the sizes and the update video below were redone for the Chat and Studio chapter.
Frame timing, the film and the demos are as checked on 15 October, except where a section says so.

## Checked in browsers

`pnpm --dir apps/site check:browser` drives the page in Chromium and WebKit at 1920×1080,
1440×900, 1280×800, 1024×768, 768×1024, 390×844, 375×667 and 844×390. At each size the page opens
still on the app's task picker and the first demo plays when picked; the stage and the chat rail
sit side by side with no empty column between them; the window's rail has a dot for each task; and
fifteen moments through the story each show their words inside the screen and below the site's bar, with nothing overflowing sideways and
nothing logged as an error. It then
checks reduced motion (nothing plays by itself), JavaScript off (the story reads as sections with
the install command) and an axe scan for WCAG 2.2 A and AA at 1440×900 and 390×844, in the app and at
the install card. The last full run passed every view in both engines: 240 chapter views, and 30 more
in Chinese. It stopped once at the policy check, on a step the app had outgrown (a file row in the
chat keeps Open in its menu now), so the sections after the matrix passed in a second run at 1440×900
in Chromium, with the step fixed. Screenshots and results go to ignored `qa/check/`.

This is not a claim of complete accessibility conformance, and it does not replace a physical
phone: GPU timing, heat and touch on real iPhones and Android phones have not been measured.

## Frame timing

Measured on the production build in Chromium (Metal), scrolling the whole story in 14 seconds:

| Size | Frames | Median | p95 | Worst |
|---|---|---|---|---|
| 1440×900 | 638 | 16.7 ms | 33.4 ms | 33.5 ms |
| 1920×1080 | 638 | 16.7 ms | 33.4 ms | 33.5 ms |
| 390×844, phone emulation | 637 | 16.7 ms | 33.4 ms | 33.5 ms |

About one frame in twenty misses one refresh; none misses two. Earlier runs stalled for up to
467 ms where a dot first wore an outfit; three things removed that: every outfit is loaded, uploaded
and compiled once the visitor scrolls into the story; the round glasses blend instead of
transmitting light, which three.js would draw as a second pass of the whole scene; and the line-up's
dots bring no lights, since every light count is a different shader. A desktop browser on a fast
machine is not a phone, and these numbers are not a promise of 60 frames a second on one.

The table is from 15 October. On 5 November only the Chat and Studio chapter was measured, scrolled
through in 8 seconds on a machine with a load average of 19: at 1440×900, 452 frames, median 16.7 ms,
p95 16.8 ms and worst 150 ms; at 390×844 in phone emulation, 480 frames, median and p95 16.7 ms and
worst 16.8 ms. The 150 ms was one frame, not traced; the likeliest cause is the phone's thread
being made, a screen before it shows.

## Size

The first view (HTML, CSS and the app's code) is 371 KB compressed: the page 4.6 KB, styles 51 KB and
the app's code 315 KB. That is over DESIGN.md's 300 KB, as the app it shows has grown: this chapter
added 5 KB to it, and it was 366 KB without. Three.js (151 KB) and the scene (14 KB) load after
the first paint, Chat on its phone (8 KB) as the story nears it, and the PDF viewer only when a PDF
opens. The outfits are 2.7 MB of models and shades, loaded when the visitor picks a task or scrolls
into the story. Each demo's recording streams, with a
lighter copy on phones. The film (16 MB at 1080p, 3.4 MB at 720p for phones) loads only when it is
played, in the page's language. The build is 97 MB, mostly recordings, the film in two languages
and the demos' results.

## The update video

The page offers "See what's new" only when the build has `public/film/localdot-update.mp4`, which the
browser check and a unit test hold it to. With a stand-in file (the film's 720p copy) the link showed
at 1440×900 and 390×844 and played in the sheet. The video itself had not been made when this was
written, and has not been checked here.

## The film

37 seconds, 1920×1080 at 60 frames a second, rendered by HyperFrames from `film/`. Its sound is
normalised to -16.5 LUFS with 2 dB of true-peak headroom in the published copies.
`npx --yes hyperframes@0.8.160 check` in `film/` passes lint, runtime, layout and motion; contrast
warns only for a model name caught mid-fade. The film was reviewed frame by frame at every beat; it has not been
watched on a phone. The Chinese cut comes from the same composition and was checked at the same
beats, its headlines whole and its punctuation set close.

## Release checks

`pnpm --dir apps/site test` (unit tests) and `typecheck` pass, and `deploy:check` builds the Worker
against the assets. `node apps/site/scripts/check-video-ranges.mjs` checks the Worker's byte ranges
for the demo recordings and the film: prefix, suffix, open-ended, invalid and unsatisfiable ranges,
`If-Range`, the film's ranges cut from the stream without reading it into memory, every cut of the
film in both languages, and lengths from the build's record when the binding sends none.

The browser check also serves the built page under its own Content-Security-Policy from `_headers`,
in Chromium and WebKit, and fails on anything the policy refuses, with the outfits' textures and a
finished task's result card loaded. It opens the page at a place, which shows only that beat with nothing played
on the way, scrolls through the places in the address, and reloads at one to land on it again. It
also reads the page in Chinese at a desktop and a phone size: nothing English
shows before the Chinese arrives, every chapter's words fit, axe passes, the film is the Chinese
cut, and the toggle goes back to English and remembers it. The built site was also served through
the Worker locally (`preview:worker`) and loaded in Chromium and WebKit, in English and Chinese,
under its production headers: no CSP violation, the first inline script runs, and a demo and the
film play.

Every demo's results were opened in the viewer (pictures, PDFs, web pages, a stylesheet, Markdown,
a spreadsheet sheet by sheet, the teaser) and downloaded as the files themselves; Revise shows that
this is a demo; the moment thumbnails and Watch replay play the task again from their moments. The
chat keeps following the newest message after the visitor scrolls back down to it or clicks in it.

Take control was tried in Chromium and WebKit at desktop size and on a phone: arriving at Step in
from early in the replay, from past its game and from another task; staying until the game loops;
playing, losing a life and handing back; and with reduced motion.

## The demos

Every demo is a real task dot did on a separate demo computer with DeepSeek V4.1 Flash, with invented
data or public sources: Breakout (12 minutes, $0.06), Kyoto (35 minutes, $0.36), the budget
(8½ minutes, $0.08), the poster (9 minutes, $0.08) and the teaser (11 minutes, $0.09). Each
recording is the daemon's own export, cut and sped up; the island shows the speed of each part. Each
was reviewed at its start, middle and end, and every line of published text was read. The private
configuration, sessions and receipts stay in ignored `qa/`.
