# localDot website

A replay-first introduction at **https://localdot.dev**. Five native-scroll chapters share one
Three.js world. App recordings, copy and controls remain ordinary accessible HTML.

## Develop and publish

This directory has its own pinned pnpm workspace and lockfile.

```sh
pnpm --dir apps/site install --frozen-lockfile
pnpm --dir apps/site dev
pnpm --dir apps/site check:browser  # while the dev server is running
node apps/site/scripts/check-video-ranges.mjs
pnpm --dir apps/site typecheck
pnpm --dir apps/site deploy:check
pnpm --dir apps/site run deploy
```

Deployment updates only the `localdot-site` Cloudflare Worker on `localdot.dev` and
`www.localdot.dev`. It does not change the app relay or download Worker. `www` redirects to the
canonical HTTPS domain. `deploy` explicitly selects `dist`; the separate holding page remains
available through `build:holding` for recovery.

## Demo provenance

The three demos are edited excerpts of **actual agent tasks** on a separate demo computer:
a LibreOffice sales table and chart, browsing public research pages, and drawing in GIMP.
Desktop and mobile variants show the real app replay, including its recorded screen and steps.
Playback is explicitly labelled **2×**. Only invented task data and public pages are used;
no personal sessions, messages, credentials or user recordings are published.

The previous still-image fixtures are no longer used for website media. Capture requires
completed recordings and a private configuration containing reviewed session IDs, the local
daemon origin, its token file path, editorial titles and excerpt ranges in seconds:

```sh
node --import ./apps/web/node_modules/tsx/dist/loader.mjs apps/site/scripts/capture-demos.ts /path/to/private-capture.json
node apps/site/scripts/check-demo-motion.mjs
```

The configuration has `origin`, `tokenFile`, and `demos`; each demo has `id`, `sessionId`,
`cellId`, `title`, `reviewed: true`, and `segments: [{from, seconds}]`. Keep it in ignored
`qa/`, alongside raw captures and provenance receipts. Review all selected footage before
publishing. Capture filters other computers and conversations out, and shortens only the
editorial replay title. Recorded actions, screen pixels and tool results are not fabricated.
The motion check compares frames **inside the computer screen**, excluding the outer UI,
and enforces the video size limit used by the public playback Worker.

Only MP4 files and WebP posters in `public/demos` are published. Capture scratch files and QA
screenshots stay in ignored `qa/`. Vite publishes `public/` and the compiled site, not the
repository or design sources. The old `check-browser`, `check-character` and `check-resilience`
scripts are retained from the prior concept; `check-experience.mjs` is the current acceptance suite.

See [DESIGN.md](DESIGN.md) for visual and motion constraints and [QUALITY.md](QUALITY.md) for
measured verification and remaining hardware coverage.
