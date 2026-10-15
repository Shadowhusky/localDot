---
name: web-app-preview
description: Run a web app or site in the computer, open it in the browser, and check pages, console errors and server logs before calling the work done.
---
# Previewing a web app

## Start it
1. Find the dev command in package.json scripts (`dev`, `start`, `preview`) or the README.
2. Run it in the background so the shell stays free, with output to a log:
   `nohup npm run dev -- --host 127.0.0.1 > /tmp/dev.log 2>&1 &`
   (Vite and Next accept `--port 5173`; set `PORT=` for others.)
3. Wait until it listens: `for i in $(seq 1 60); do curl -sf http://127.0.0.1:5173 >/dev/null && break; sleep 1; done`
   and read `tail -n 40 /tmp/dev.log` for the real URL and any build errors.

## Check it like a user
- Open the URL with `browser_navigate` and look at the page; click through the changed flow,
  submit the form, resize to a phone width if layout matters.
- Errors: read the dev log, and check the browser console (open devtools or read the page for
  error overlays). A blank page is a failure, not a pass.
- Static builds: `npm run build && npx serve dist -l 4173` (or the framework's `preview`).

## Finish
Say exactly what you exercised and what you saw. Leave the server running if the user will look
at it; otherwise stop it (`kill %1` or `pkill -f "vite"`). Never claim a flow works from a build
alone.
