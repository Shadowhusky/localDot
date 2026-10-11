# localDot website

A replay-first introduction at **https://localdot.dev**. Five native-scroll chapters share one
Three.js world. App recordings, copy and controls remain ordinary accessible HTML.

## Develop and publish

This directory has its own pinned pnpm workspace and lockfile.

```sh
pnpm --dir apps/site install --frozen-lockfile
pnpm --dir apps/site dev
pnpm --dir apps/site check:browser  # while the dev server is running
pnpm --dir apps/site typecheck
pnpm --dir apps/site deploy:check
pnpm --dir apps/site run deploy
```

Deployment updates only the `localdot-site` Cloudflare Worker on `localdot.dev` and
`www.localdot.dev`. It does not change the app relay or download Worker. `www` redirects to the
canonical HTTPS domain. `deploy` explicitly selects `dist`; the separate holding page remains
available through `build:holding` for recovery.

## Demo provenance

Every replay uses the real app UI with the isolated **synthetic** UI fixtures. No personal
sessions, WeChat messages, credentials or user recordings are included. Research and drawing
computer frames are purpose-made sample content (`scripts/demo-screen.mjs`), not evidence of
an executed agent task. The page labels these as interface demos with sample data.

To refresh all desktop and portrait media, from the repository root with the web build and its
Playwright browsers available, plus FFmpeg installed:

```sh
node --import ./apps/web/node_modules/tsx/dist/loader.mjs apps/site/scripts/capture-demos.ts
node --import ./apps/web/node_modules/tsx/dist/loader.mjs apps/site/scripts/capture-demos.ts --mobile
```

Only MP4 files and WebP posters in `public/demos` are published. Capture scratch files and QA
screenshots stay in ignored `qa/`. Vite publishes `public/` and the compiled site, not the
repository or design sources. The old `check-browser`, `check-character` and `check-resilience`
scripts are retained from the prior concept; `check-experience.mjs` is the current acceptance suite.

See [DESIGN.md](DESIGN.md) for visual and motion constraints and [QUALITY.md](QUALITY.md) for
measured verification and remaining hardware coverage.
