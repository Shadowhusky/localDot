# localDot website

The site at **https://localdot.dev** opens inside localDot: the app's own chat, Theatre and dot
play real tasks dot did, and scrolling steps out of the app into dot's studio, where dot walks
through what localDot does. See [DESIGN.md](DESIGN.md) for the experience and
[QUALITY.md](QUALITY.md) for what has been checked.

## Develop and publish

The site has its own pnpm workspace and lockfile, and builds the app's components from
`apps/web/src` and `packages/*`, so install the repository root first.

```sh
pnpm install                                  # the repository root
pnpm --dir apps/site install --frozen-lockfile
pnpm --dir apps/site dev                      # http://127.0.0.1:4321
pnpm --dir apps/site test
pnpm --dir apps/site typecheck
SITE_URL=http://127.0.0.1:4321 pnpm --dir apps/site check:browser
node apps/site/scripts/check-video-ranges.mjs
pnpm --dir apps/site deploy:check
pnpm --dir apps/site run deploy
```

Vite loads its configuration with `--configLoader runner`, because the page's words about dots
and models are generated at build time from `packages/protocol`, `packages/providers` and the
app's `dot/voices.ts`.

The build also hashes the page's inline script into the CSP in `_headers`, and records the length
of each of the site's videos in `media-lengths.json` for the Worker's byte ranges.

The videos (the films and the demos' recordings) are not kept in git: the films carry licensed
music, and the demos come from reviewed sessions. Render the films (Film) and build the demos
(Demos) to get them back, or the site builds without them.

The page's Chinese is in `src/i18n/zh.ts`, keyed by the English it stands for; an element marked
`data-i18n` takes its line, and the tests fail if a marked line has no Chinese or the dictionary
keeps one the page no longer says.

Deployment updates only the `localdot-site` Cloudflare Worker on `localdot.dev` and
`www.localdot.dev`. It does not change the app relay or download Worker. `www` redirects to the
canonical HTTPS domain. `deploy` explicitly selects `dist`; the separate holding page remains
available through `build:holding` for recovery.

## How it fits together

- `src/hero`: the app in the hero. Its chat, Activity, plan, file viewer and Theatre frame are the
  app's own components; a demo's events go through the app's own reducer and stage model as its
  recording plays (`DemoFeed`). `site-api.ts` stands in for the daemon and serves only what a demo
  recorded about its results.
- `src/dot3d`: dot in Three.js. The body's shader paints the eyes from the app's eye geometry, the
  app's `DotEngine` moves it, and outfits are the GLBs from `tools/dot-plates/export_glb.py`.
- `src/scene`: the renderer, the app's screen placed in 3D with a CSS `matrix3d`, the ring of
  models and the export clips.
- `src/story`: scroll to chapter progress (`Director`), the camera and dot keyframes (`shots.ts`),
  each chapter's words fading in on their beats, and the places the address names (`places.ts`).

## Demos

Each demo is a real task dot did on a separate demo computer, with invented data or public
sources, by the dot made for that job: a Breakout game (coder), three autumn days in Kyoto
(researcher), a budget from an invented bank export (finance), a gig poster (designer) and a
Reels teaser of Big Buck Bunny, CC BY 3.0 (video editor). The Theatre video is the daemon's own
export of each recording, cut and sped up; the island shows the speed of each part, and the time
and cost are the task's own.

A demo's results open in the app's own viewer and download as the files themselves: the bundle
keeps each file with its preview, pages, versions, text view and, for a spreadsheet, each sheet's
table, and `site-api.ts` answers the app as the daemon would. What only localDot itself can do,
such as Revise, says in a toast that this is a demo.

`scripts/demo-bundle.ts` builds a demo from a reviewed session:

```sh
node scripts/demo-bundle.ts qa/live/bundles.json [demo-id]
```

The private configuration in ignored `qa/` names each demo's session, title, request, dot, cuts
(session seconds and speed) and, optionally, `until` (where to stop keeping events), `cards`
(exports with captions or dot for the export chapter) and `freeze` (frames of the finished video
the recording caught mid-glitch, each shown as the frame before it). The bundle is `public/demos/<id>/`
(`timeline.json`, `theatre.mp4`, a lighter `theatre-sm.mp4` for phones and a poster) and the
results dot handed over, with their previews, in `public/file-previews/<id>…/`, where the app's
file viewer looks for them. Review every recording and every published line before publishing.
`scripts/record-demo.mjs qa/live/demos.json <id>` records a new demo: it switches the dot only while the task starts, starts
it in a new conversation and gives the owner's conversation back when it ends.

## Film

The promo film is a [HyperFrames](https://github.com/heygen-com/hyperframes) composition,
`film/index.html`. Its 3D layer is the site's own dot (`src/film`). `film/cues.json` holds its
marks, montage, outfits and sound cues; the clips' windows in `film/index.html` and the score's
sections in `film/score.py` follow the same 120 bpm bars by hand, so change them together.

```sh
node film/capture.mjs     # the app's window, from the running dev server
node film/assets.mjs      # the 3D layer, outfits, type, demo clips, the paddle's track and the score
cd film
npx --yes hyperframes@0.8.160 preview    # the Studio
npx --yes hyperframes@0.8.160 render -q delivery -f 60 -o renders/localdot-film.mp4
npx --yes hyperframes@0.8.160 render -q delivery -f 60 --variables '{"lang":"zh"}' \
  --strict-variables -o renders/localdot-film-zh.mp4
```

Every word the film shows, in English and Chinese, is in `src/film/copy.ts`; the render's `lang`
variable picks one.

The site plays `public/film/`: the film at 1080p, a 720p copy for phones and a poster. The render's
sound comes out quiet, so it is normalised once, in two passes, to -16.5 LUFS with true-peak
headroom for the AAC encode, and both copies take that sound.

```sh
FILM=film/renders/localdot-film.mp4
ffmpeg -i $FILM -af loudnorm=I=-16.5:TP=-3.5:LRA=11:print_format=json -f null -
# Put the measured input_i, input_tp, input_lra, input_thresh and target_offset in the second pass.
ffmpeg -i $FILM -vn -af "loudnorm=I=-16.5:TP=-3.5:LRA=11:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=…:linear=true" sound.wav
ffmpeg -i $FILM -i sound.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -movflags +faststart \
  public/film/localdot-film.mp4
ffmpeg -i $FILM -i sound.wav -map 0:v -map 1:a -vf scale=-2:720:flags=lanczos -c:v libx264 \
  -preset slow -crf 24 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart \
  public/film/localdot-film-720.mp4
ffmpeg -ss 24.6 -i $FILM -frames:v 1 -vf scale=1280:-2 poster.png
cwebp -q 82 poster.png -o public/film/poster.webp
```

The Chinese cut is encoded the same way to `localdot-film-zh.mp4`, `localdot-film-zh-720.mp4` and
`poster-zh.webp`.

The score (`film/score.py`) arranges Apple Loops from GarageBand's Disco Funk pack. The GarageBand
licence allows them, royalty free, in an original soundtrack, but not on their own, so the loops
and the mixed `music.wav` stay in the ignored `film/assets/`, and only the finished film is
published. The film's music is not under the MIT licence. The teaser in it is cut from Big Buck
Bunny (Blender Foundation, CC BY 3.0), credited on the end card.

## Link previews

The public homepage ships Open Graph and large-image card metadata in its initial HTML,
with the same public, versioned JPEG used by the local app. The card is 1200 × 630 and uses
only the product mascot and copy, never a user desktop or recording. Source artwork is
`artwork/social-card.html`; preview it with the dev server and capture its 1200 × 630 canvas
when updating the design. Bump the JPEG filename when the image changes to avoid stale
preview caches. Keep the app and homepage title, description and image metadata aligned.
