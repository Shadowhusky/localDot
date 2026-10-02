# Part 2 plan — revision 1 change log (v1 → v2, 2026-10-01)

Plan: /Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-core-part2.md (v2: 8,774 lines, 18 tasks: 1, 2, 3, 3b, 4, 5, 6, 6a, 6b, 7–15). Line numbers below are v2.

## Findings
1. Cross-realm instanceof → `tapVideoTrack` takes `{ srcObject }` and checks the stream by shape (`VideoLike`/`StreamLike`), `DesktopFrame` checks `tagName === "VIDEO"` and `typeof getVideoTracks === "function"`; new unit test feeds a plain object with `getVideoTracks()` under a stubbed `MediaStreamTrackProcessor` — lines 7916–7980 (frame-source + test), 8125–8160 (DesktopFrame).
2. extract-selkies-client.sh → `mkdir -p "$1"`, `dest="$(cd "$1" && pwd)"` before the `cd`, `rm -rf` on the resolved path, also strips the manifest link and verifies icons + LICENSE — 1479–1495; Task 14 calls it with `"$PWD/apps/web/vendor/selkies"` — 7729–7740.
3. e2e harness → spawns `process.execPath --import tsx src/main.ts` from `apps/daemon`, `detached: true`, `killGroup(-pid)` SIGTERM then SIGKILL after 10 s, throws if `/healthz` never answers; acceptance checks `lsof -nP -iTCP:4790` is empty — 8366–8415, 8490–8494.
4. Stream tickets vs P2-R2 → one live ticket per cell (`issue` returns the existing one), `resolve` compares with `timingSafeEqual`, `cellRoutes` subscribes and revokes whenever a cell leaves `ready` (covers POST stop and orchestrator stop); API test covers reuse, revoke-on-stop, re-issue, revoke-on-delete; Stage mints once per `ready` transition (unchanged) and never accumulates — 3206–3240 (registry), 3085–3101 (test), 5380–5386 + 5425 (api), 4960–4990 (api test), Global Constraints 74–76.
5. Tailwind 4 @theme shape → `theme.css` uses `--color-*`, `--font-ui/mono`, `--spacing-rail`, `--radius-stage`, `--shadow-stage`, `--duration-press`, `--ease-press`; every use in Tasks 12–14 renamed; Interfaces note — 6559–6650, 6137–6142, Global Constraints 88–90.
6. GIMP assertion → `/Image Manipulation Program/` — 718.
7. Selkies ping fact → corrected everywhere: data socket is aiohttp `WebSocketResponse(heartbeat=30, autoping=False)`, the 0.2 s `PING_INTERVAL` is the uplink gauge's; watchdog rests on the daemon's 500 ms pings; S8 idle expectations (pongs/s ≈ 2, pings/s ≈ 0.03) — 1452–1461, Task 4 Step 3 expectations (≈1596–1604), 5540–5545, 5917–5924, decisions 8758–8759.
8. P2-R1 license text → `selkies-client` stage copies `/usr/share/common-licenses/MPL-2.0` to `/LICENSE`; NOTICE names Selkies 2.0.0, the one removed link and the LICENSE file — 659–660, 7740–7758.
9. Docker restarts (P2-R14) → `RestartPolicy` removed from both specs with assertions; orchestrator `#watch` restarts with backoff [2,4,8,16,30] s, re-reads ports via `#startContainers`, gives up after the list; Docker test asserts no restart policy; Review Focus 2 rewritten — 3347, 3380, 3420–3470, 4157–4182, 4385–4425, 3916–3966 (tests), ≈4585 (docker test), 117–121, 77–78.
10. reconcile() → per-cell try/catch; desktop-exited-while-gate-runs → `failed` with the exit code; other Docker errors → `failed` with the message; new test — 4225–4248, 3969–3995.
11. LibreOffice first-run modals → `registrymodifications.xcu` template (FirstRun=false, ShowTipOfTheDay=false) seeded by startwm.sh on first run; image test asserts it — 838–848, 785–795, 1135–1142, file map 140.
12. Carry-forward items → new Task 6b (A19 session metadata) and an explicit "Part 3 obligations" list — 2717–2889, 8705–8728.
13. Biome React domain → `onStats` read through `onStatsRef`; the false claim replaced by the explanation — 8060–8085.
14. Test count → "17 tests pass (6 spec, 11 orchestrator)" — 4514.
15. selkies-client stage → `COPY --from=<pinned image ref>` for index.html, assets, icon.png, icon-512.png, LICENSE (no base stage build); manifest link stripped by the extractor — 650–661, 1488–1492.
16. Emoji font → `fonts-noto-color-emoji` in apt list and `Noto Color Emoji` asserted — 603, 742–748.
17. doctor probe network → random hex suffix per run, deleted by id in `finally` — 4780–4784.
18. Vite 8 `esbuild` option → removed from `vitest.config.ts` with a comment — 218–221.
19. Screenshot instruction → one clear instruction: pass the `#token=` URL to `shot`; `shot` gained a `settleMs` argument — 8275–8282, 6865–6876, 6137–6139.
20. startwm.sh rewrite → stated as intended (theme changes in the desktop do not survive a restart) and the WhiteSur names live there — 842–843, 1296–1298.
21. Playwright skips → top-level `test.skip(!DOCKER, …)` / `test.skip(!MEASURE, …)` — 8434, 8510.
22. `octets[0]!` → `octets.reduce((acc, o) => acc * 256 + o, 0)` — 295.
23. Look in the Goal and decisions → Goal names the macOS look; decisions entry rewritten; Task 3's title unchanged (3b owns the look) — 5–8, 8744–8773.
24. relay bufferedAmount → noted in Task 11's intro and listed as a Part 3 obligation — 5543–5545, 8717–8718.

## Ruling placements
- P2-R5 (macOS look) → new Task 3b between Task 3 and Task 4: commit-pinned WhiteSur GTK (pre-built Light theme + xfwm4 -hdpi/-xhdpi assembled from the source tree, no sassc) and icon theme, Plank with WhiteSur's dock theme via `/usr/local/bin/localdot-plank` + autostart, menu-bar `xfce4-panel.xml`, `CHM|` buttons, template name changes, tests + 2×/1× screenshots; knock-ons in Task 15 acceptance (8488–8494), README (8630–8633), Part 3 geometry note (8697–8703) — 1177–1437.
- P2-R11 (lock residuals) → new Task 6a after Task 6: temp file + linkSync publish, own pid stale, `DaemonLockError` for a directory/unreadable lock, SIGHUP, node-direct start in Global Constraints (79–82) and README (8622–8628) — 2460–2716.
- P2-R12 (LIGHT) → Task 3b installs only `-Light` (release tarball, `assets-Light-*`, icon theme `WhiteSur`), decisions 8764 — 1180, 1228–1262.
- P2-R13 (licenses) → Step 1 resolve step prints both COPYING heads; MIT/GPL-3.0 copied into `/usr/share/doc/localdot-themes/`; `cells/desktop/THIRD-PARTY.md` table — 1205–1222, 1267–1285.
- P2-R14 (no restart policy) → see finding 9; Global Constraints 77–78; Review Focus 117–121.
- P2-R15 (A19 + explicit carries) → Task 6b (2717–2889) and "Part 3 obligations carried from Part 1 and this plan" (8705–8728); decisions 8768–8770.

Not applied: nothing. Unverifiable offline and left as resolve steps: the two WhiteSur tag commits (printed by `git ls-remote --tags`, values recorded) and both COPYING heads (read after the clone); no archive sha256 is used because the sources are pinned by commit and verified with `git rev-parse HEAD`.
