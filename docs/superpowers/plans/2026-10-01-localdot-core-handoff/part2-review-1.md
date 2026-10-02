# Part 2 plan review 1 (fable) — verdict: Needs revision. Line numbers refer to plan v1 (scratchpad/part2-plan-v1.md).

## Critical
1. Cross-realm instanceof — Task 14 lines 6973–6974, 7136–7139: `video.srcObject instanceof MediaStream` / `video instanceof HTMLVideoElement` / `stream instanceof MediaStream` are always false for objects from the iframe's realm → no frame source, e2e `data-frames > 0` (7418) fails while HUD says Live. Fix: duck-type (`video?.tagName === "VIDEO"`, `typeof srcObject?.getVideoTracks === "function"`) or the iframe's own constructors; add a unit test feeding a plain object with getVideoTracks().
2. extract-selkies-client.sh — Task 4 lines 1158–1162 (used Task 14 line 6767): cds into cells/desktop before `rm -rf "$dest"` and `--output dest=$dest`, so relative `apps/web/vendor/selkies` lands in cells/desktop/apps/web/... Fix: resolve dest absolute before the cd (`mkdir -p "$1" && dest="$(cd "$1" && pwd)"`), rm -rf the resolved path.
3. e2e harness — Task 15 lines 7357–7361, 7379: starts the daemon via pnpm and kills with SIGTERM; pnpm does not forward it → orphan holds 4790 + daemon.lock; later playwright runs (7453, 7528–7529) fail. Fix: spawn `node --import tsx apps/daemon/src/main.ts` (cwd REPO) or detached + process.kill(-pid); fail the harness if /healthz never answers.
4. Stream tickets vs P2-R2 — Task 7 2446–2464, Task 10 4458–4475, Task 14 7169–7185: (a) revoked only on DELETE; POST …/stop (4458–4466) and orchestrator stop() (3417–3428) leave them valid; (b) resolve() is a Map.get, not constant-time; (c) Stage mints a new ticket on every `ready` transition (7176), never pruned (registry + daemon-origin localStorage via Selkies' origin+pathname settings keys grow). Fix: one live ticket per cell (issue replaces), revoke on stop and remove (orchestrator listener on any non-ready state), store sha256(ticket) and look up by digest (or timingSafeEqual), reuse while the cell stays ready.
5. Tokens not shaped for Tailwind 4 @theme — Task 12 5603–5630: use namespaced names (--color-void, --color-xenon, --color-hud, --font-ui, --font-mono, --spacing-rail, --ease-press; short aliases optional).

## Important
6. GIMP assertion Task 2 line 686: `gimp --version` prints "GNU Image Manipulation Program version 3.x"; /GIMP/i fails. Use /Image Manipulation Program/ or `command -v gimp`.
7. "Selkies pings every 0.2 s" is wrong (lines 1133–1135, 1464–1469, 4583–4586, 4965–4966): PING_INTERVAL 0.2 is UplinkGauge's (file-transfer pacing only, stream_server.py:255–345); the data socket is WebSocketResponse(heartbeat=30, autoping=False) (websockets_mode.py:6050). S8's "pings/s ≈ 5" would read ~0.03. Fix the text: the watchdog rests on the daemon's own 500 ms pings (keep P2-R6's constants on that basis).
8. P2-R1 license text missing — Task 14 6772–6784: ship apps/web/vendor/selkies/LICENSE (MPL-2.0 text) and pin the upstream version (Selkies 2.0.0) in NOTICE.
9. Docker restarts change gate ports — Task 8 2711, 2752, 3470 → P2-R14 (drop the policy; orchestrator restarts with backoff and re-reads ports; Review Focus line).
10. reconcile() — 3330–3351: gate running + desktop exited is labelled `stopped` not `failed` with exit code; a non-404 Docker error on one record aborts the loop. Fix: per-cell inspect in try/catch, mark `failed: <message>`.
11. LibreOffice first-run modals not disabled (Task 3 templates 755–757): seed registrymodifications.xcu (Misc/FirstRun=false, Misc/ShowTipOfTheDay=false) copied on first run like thunar.xml; assert in the desktop-image test.
12. Carry-forward items dropped silently (7604–7693) → P2-R15.
13. Biome React domain is on (useExhaustiveDependencies, useHookAtTopLevel) contrary to line 7113; StageCanvas's useEffect(…, []) reading onStats will be flagged. Store onStats in a ref (or scoped biome-ignore) and correct the claim.

## Minor
14. Line 3575: Task 8 runs 14 tests (6 spec + 8 orchestrator), not 13.
15. Lines 626–628: the selkies-client stage copies from `base`, so --target builds the whole apt/Node/VSCodium stage; copy from the pinned image reference; include manifest.json, icon.png, icon-512.png (index.html links them) or strip the links.
16. Line 578: spec "Look" asks for emoji fonts — add fonts-noto-color-emoji (with P2-R5) and assert Noto Color Emoji.
17. Lines 3806, 3840–3856: a stale localdot-doctor-probe network makes every later doctor run fail (409 duplicate name); delete by name first or suffix the name.
18. Line 196: Vite 8 marks `esbuild` config @deprecated (use oxc); drop it (JSX runtime is automatic by default) or use oxc.jsx.
19. Lines 7267–7269: screenshot instruction contradicts itself; say once that `shot` must get the #token= URL.
20. Lines 808–809: startwm.sh rewrites xsettings.xml on every start (in-desktop theme changes lost on restart) — acceptable, say so; P2-R5's theme names live there.
21. Line 7399: use a top-level `test.skip(!DOCKER, …)` instead of test.skip inside beforeAll.
22. Line 271: `octets[0]!` may trip noNonNullAssertion; destructure with Number().
23. Line 7690 and Task 3's title must change under P2-R5; the Goal (line 5) names the look.
24. Line 4583+: relay() never checks client.bufferedAmount — note as a Part 3 item.

## P2-R5 placement (reviewer's proposal; apply with P2-R12's LIGHT variant)
New Task 3b "Desktop image — the macOS look" between Task 3 and Task 4.
- Task 2 Dockerfile (573–579, 618–623): add plank (Ubuntu universe), fonts-noto-color-emoji, sassc; download WhiteSur-gtk-theme and WhiteSur-icon-theme release tarballs at a pinned tag (newest tag 2026-09-10) with ARG …_SHA256 + sha256sum -c; install the GTK theme into /usr/share/themes with its installer (light colour variant, HD/size options as needed; its libs/lib-install.sh installs xfwm4 <name>, <name>-hdpi, <name>-xhdpi) and the icon theme into /usr/share/icons. Record licenses in-image and in a repo notice (P2-R13).
- Task 3 templates (818–845, 848–938) and startwm.sh (802–809): Net/ThemeName and Net/IconThemeName → the WhiteSur light names; the scale case maps 2 → the -xhdpi xfwm4 theme, 1 → the base one; button_layout → "CHM|" (macOS order, left), title_alignment center; /defaults/xfce/xfce4-panel.xml styles the top panel as a menu bar (applications menu, expanding separator, status tray, clock right; size 26 so GTK ×2 renders 54 px as the spec and S2 measured); Plank from /etc/xdg/autostart/localdot-plank.desktop (OnlyShowIn=XFCE) with WhiteSur's Plank theme (nothing depends on the home volume).
- Tests (Task 3 Step 4, 1046–1052, 1086–1094, 710–715): xfwm4 theme expectations become the WhiteSur names at 2× and 1×; add /Net/ThemeName, /Net/IconThemeName, `pgrep -x plank` as abc, Noto Color Emoji; panelGeometry unchanged; screenshot check at 2× and 1× (`import -window root` via docker cp), looked at by the executor.
- Knock-ons: S8's run-desktop.sh picks it up; Task 15 acceptance Expected (7454) says the stage shows the WhiteSur chrome, the menu-bar panel and the Plank dock; the Part 3 interface note (7646–7651) records the dock's strut and the 54 px top panel; README (7578–7594) mentions the look; line 7690 rewritten.

## P2-R11 placement (reviewer's proposal)
Separate Task 6a "Daemon lock residuals (Ruling 36)" (or Steps 0a–0c of Task 6):
- lock.ts: write `${file}.<rand>.tmp` with the pid (0600, wx) then linkSync into place; on EEXIST read the holder; a dead pid OR the daemon's own pid is stale → renameSync the temp over it; an unreadable file or a directory at the path throws a DaemonLockError with a one-line message (main.ts's lockHome catches both error classes and fail()s without a stack trace).
- main.ts (Task 10 block 4525–4559): add "SIGHUP" to the signal list.
- lock.test.ts: the file holds the pid the instant acquireDaemonLock returns; a lock holding process.pid is replaced; a directory at the path → the message; an unreadable file → the message.
- Global Constraints (43–89) and README (7578–7594): process managers and harnesses start the daemon with `node` directly; `pnpm … start` does not forward SIGTERM (also Critical 3's fix).
