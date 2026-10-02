# Task 5 report: desktopd skeleton with a token-protected health check

**Status: DONE_WITH_CONCERNS.** Everything is built and verified. The concerns are four small
deviations from the brief (listed below, with reasons) for the controller to accept or veto,
plus three residual notes for Part 3.

Branch `feat/core-part2`, base `b8a6d2f`. Working tree clean after the commits.

| Commit | Message |
|---|---|
| `4195ea0` | `perf(desktop): turn off the compositor's vsync` (ruling 1, its own commit, first) |
| `8e9262f` | `feat(desktopd): health endpoint behind the cell token` |

Neither commit has a `Co-Authored-By` or any AI attribution line.

Final image: `localdot/desktop:dev` = `6452129c4aab`.

## Test summary

| Check | Result |
|---|---|
| `pnpm test` (non-Docker) | 18 files, 154 tests passed (was 16 files / 145 at Task 3; +2 files, +9 tests here) |
| desktopd unit tests | 9/9 (brief's 5 + 1 not-ready test in `app.test.ts`, + 3 in `xsettings.test.ts`) |
| `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts` | 19/19, three times on the final image `6452129c4aab` (38.3 s, 38.2 s, 38.1 s). Also 19/19 ×3 on `2f64cab7de24`, which is the same build without the license header |
| `pnpm format` | no fixes on the final tree (an earlier pass rewrapped the two new test files) |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 (now includes `cells/desktop/desktopd`) |
| `pnpm hygiene` | exit 0 |

The brief expected 16 Docker tests. That count was stale: the file already had 17 after Task 3b's
fix round. This task adds "composites without vsync" and "runs desktopd as the desktop user behind
the cell token", which makes 19. The 1x desktopd check lives inside the existing 1x test.

## Ruling 1: the compositor's vsync is off (`4195ea0`)

**Change.** `cells/desktop/root/defaults/localdot/xfwm4.xml.in` now sets
`/general/vblank_mode` to `off` (it was `auto`). `startwm.sh` writes this template before it execs
`xfce4-session`, and xfwm4 reads the mode only as it starts. The compositor stays on, for Plank's
translucent dock.

**Probe.** Added to `desktop-image.docker.test.ts`:
- At 2x, a new test "composites without vsync":
  `expect(xfconf(C2, "xfwm4", "/general/vblank_mode")).toBe("off")`.
- At 1x, the same line in "switches to 1x with LOCALDOT_SCALE=1".
- `xfconf` is `outputAs(…, "xfconf-query", …)`, which asserts exit 0.

**RED on the current image `c1522d532570`** (the b7ee200 build; nothing under `cells/desktop` that
the image uses had changed since). Command: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file> -t
"composites without vsync|switches to 1x"`:
```
× composites without vsync 69ms
× switches to 1x with LOCALDOT_SCALE=1 7300ms
AssertionError: expected 'auto' to be 'off'      (at :308, the 2x probe)
AssertionError: expected 'auto' to be 'off'      (at :566, the 1x probe)
Tests  2 failed | 16 skipped (18)
```

**The running xfwm4, not only the xfconf value.** This was a manual check, not part of the suite. I
started a throwaway container with `G_MESSAGES_DEBUG=all`, so xfwm4 logs which vsync method it
picked as it starts:
```
old image c1522d532570: xfconf "auto"  ->  xfwm4-INFO: Compositor using XPresent for vsync
new image 5f92e3e0acb6: xfconf "off"   ->  xfwm4-INFO: No vsync support in compositor
                                           compositor (_NET_WM_CM_S0 owned): True
```
`ps` shows the session's xfwm4 runs as plain `xfwm4`, with no `--vblank` override.

**GREEN.** The image was rebuilt as `5f92e3e0acb6`; only the overlay layers rebuilt. The full file
passed 18/18 (it had 18 tests at that commit).

**Look.** The saved 2x screenshot (`apps/daemon/src/cells/testing/out/look-2x.png`, from the
final-image run) is unchanged: a light menu bar, Thunar with its traffic lights and frame shadow,
and the translucent dock over the dune. A static screenshot cannot show tearing, which stays P3-C15's
motion-capture check.

## desktopd (`8e9262f`)

Files are as the brief lists them: package, `tsconfig.json`, `build.mjs`, and `src/{main,app,auth,
xsettings}.ts`, plus `src/xsettings.test.ts`. The s6 service is `svc-desktopd` (`type` longrun, `run`
mode 755, `dependencies.d/svc-de`, `user/contents.d/svc-desktopd`). Also changed: the Dockerfile,
`build.sh`, `pnpm-workspace.yaml`, the lockfile, `THIRD-PARTY.md`, and the Docker test.

- **Step 1.** `pnpm install` added only the `cells/desktop/desktopd` importer (+16 lockfile lines)
  and downloaded nothing (`downloaded 0`).
- **Step 3 RED.** Both test files failed to load. Vitest 5 words it `Error: Cannot find module
  './app.ts' imported from …` (and the same for `./xsettings.ts`), not the brief's "Failed to load
  url".
- **Step 5.**
  - `pnpm exec vitest run …`: 9/9.
  - `pnpm --filter @localdot/desktopd build` printed `dist/desktopd.mjs 106.0kb`, or 108.2 kB with
    the license header. The brief estimated 300–400 kB; Hono is smaller than that.
  - The bundle exits 1 with `desktopd: LOCALDOT_DESKTOPD_TOKEN must be at least 32 characters` when
    the token is missing or short.
- **Step 6.**
  - The `chmod 755` line keeps every earlier path, including `init-gamepad-lock/run` (which the
    brief's quote leaves out) and `/usr/local/bin/localdot-plank`, and adds
    `/etc/s6-overlay/s6-rc.d/svc-desktopd/run`.
  - The final stage is the brief's: `COPY` the bundle, `chmod 644`, `EXPOSE 3000 7700`.
  - `build.sh` is the brief's.
  - `cells/desktop/build.sh` re-ran only the overlay steps: `COPY THIRD-PARTY.md`, `COPY root/`, the
    chmod, and the two desktop-stage steps. The wallpaper download step and everything before it
    were cached.
- **Step 7.**
  - `startDesktop(name, scale): { port: number; desktopd: number }` publishes `127.0.0.1:0:7700` and
    passes `LOCALDOT_DESKTOPD_TOKEN` (ruling 5).
  - The describe keeps `port2` and adds `desktopd2`, both set in `beforeAll`.
  - The desktopd test sits before "switches to 1x".
  - RED on the image without desktopd (`5f92e3e0acb6`): the process probe got `[]`, and the 1x
    health fetch failed with `TypeError: fetch failed … SocketError: other side closed`.

### How the daemon will see "not ready" (ruling 2)

`GET /healthz` with the right token always answers **HTTP 200** with a `DesktopdHealth` body, whose
shape is unchanged from the brief. Not ready is:
```json
{ "ok": false, "scale": 2, "display": ":1", "screen": { "w": 2560, "h": 1600 },
  "hidpi": { "ok": false, "expected": { "windowScalingFactor": 2, "xftDpi": 96 },
             "windowScalingFactor": null, "xftDpi": null } }
```
That is, `ok: false` and `hidpi.ok: false`, with **both** `hidpi.windowScalingFactor` and
`hidpi.xftDpi` `null`. The screen is reported as read. How the daemon should read each answer:
- **`ok: true`:** the HiDPI state is verified.
- **`ok: false` with both fields `null`:** not ready yet. Keep polling until the deadline. Once the
  session is readable, both fields are never null together, because `startwm.sh` always writes both
  properties.
- **`ok: false` with numbers:** a real mismatch, to report.

Not-ready answers ok at neither scale. That is new: the brief's `hidpiReport` read null as XFCE's
default, which is ok at 1x. So `readXsettings` now returns `Xsettings | null`, and
`hidpiReport(scale, null)` is never ok. An unset property (a null field inside an object) still
means XFCE's default, as the brief's "treats unset xsettings" test pins.

How long not-ready lasts, measured on the final image by polling `/healthz` every 10 ms from
`docker run`, on a home that had just run at 2x and restarted at 1x:
```
0.2s [poll 1]  fetch error: UND_ERR_SOCKET                 (desktopd not listening yet)
0.5s [poll 20] 200 {"ok":false,"scale":1,…,"hidpi":{"ok":false,…,"windowScalingFactor":null,"xftDpi":null}}
0.5s [poll 24] 200 {"ok":true,"scale":1,"screen":{"w":1280,"h":800},"hidpi":{"ok":true,…,"windowScalingFactor":1,"xftDpi":96}}
```
desktopd started listening at 17:00:41.265. xfce4-session made its first xfconf call at .329. So at
boot the window is about 60 ms. A session restart opens it again.

### Deviations from the brief, for the controller

1. **The xfconf gate checks `xfce4-session` as well as `xfconfd`.** `readXsettings(uid, run)` runs
   `pgrep -u <uid> -x xfce4-session`, then `pgrep -u <uid> -x xfconfd`. It calls `xfconf-query` only
   when both are found; otherwise it returns `null`.
   - The ruling names the xfconfd check as an example ("e.g."); the requirement is "never activate
     xfconfd before the session is up".
   - The xfconfd check alone leaves a window. An xfconfd can be running before the session: one left
     from the previous session (`svc-de` restarts `startwm.sh` after a crash), or one that Selkies'
     DPI restore activated.
   - In that window `startwm.sh`'s `pkill` loop is about to kill it. A health check could see it
     running, and then its `xfconf-query` would start a fresh one after the kill and before the
     templates' `mv`. That is the stale-files race.
   - The session check closes that window. `startwm.sh` execs `xfce4-session` only after both
     template writes, and while it runs it is named `bash`, not `xfce4-session`.
   - desktopd runs as the session user (`s6-setuidgid abc`), so its own `userInfo().uid` is the
     session uid.
   - **Pinned by `xsettings.test.ts`.** With `[]`, `["xfce4-session"]` (the ruling's exact case: no
     xfconfd) or `["xfconfd"]` running, the result is `null` and `xfconf-query` is never invoked.
     With both running, the exact call sequence is pinned.
   - **RED.** The brief's ungated reader, given an injected runner, failed that test with
     `AssertionError: expected { windowScalingFactor: 2, xftDpi: 96 } to be null`.
   - **Mutations.** Dropping only the xfconfd check fails with `xfce4-session: expected {…} to be
     null`. Dropping only the session check fails with `xfconfd: expected {…} to be null`. The file
     was restored byte-for-byte afterwards (`cmp`).
   - **Live.** In both boot logs (2x on a fresh home, then 1x on that 2x home), the only
     `org.xfce.Xfconf` activation on the session bus was requested by `comm="/usr/bin/xfce4-session"`,
     never by `xfconf-query`.
2. **License notices in the bundle (not in the brief).** `desktopd.mjs` bundles Hono 4.13.12 and
   @hono/node-server 2.1.3, both MIT, whose terms require the notice in copies.
   - Before this change, `THIRD-PARTY.md` called desktopd localDot's own MIT code, and neither
     notice was in the image.
   - `build.mjs` now reads both packages' `LICENSE` files into the banner as a `/*! … */` comment,
     so the one-file bundle and the brief's Dockerfile lines are unchanged. Neither text contains
     `*/`, and `node --check` passes.
   - `THIRD-PARTY.md` gains two rows.
   - The desktopd Docker test asserts `grep -c "^Permission is hereby granted"
     /opt/localdot/desktopd.mjs` prints `2` and exits 0. It failed first on `2f64cab7de24`: it
     printed 0 and exited 1.
   - Cost if vetoed: revert the banner, the rows and the one probe.
3. **Process probe.**
   - The brief's `sh -c "ps -o user= -p $(pgrep -f desktopd.mjs | head -n 1)"` can match the probe's
     own shell, whose command line contains `desktopd.mjs`. A manual check in this task showed
     exactly that: a `sh -c 'pgrep -f desktopd.mjs'` "found" desktopd in a cell where it was
     crash-looping.
   - I replaced it with one exit-checked `outputOf(C2, "ps", "-eo", "user=,args=")`. It filters the
     lines that contain `desktopd.mjs` and expects exactly one, matching
     `^abc\s+/opt/node/bin/node /opt/localdot/desktopd.mjs$`.
4. **A 1x desktopd check.** At 2x, the brief's test cannot tell "reads `LOCALDOT_SCALE`" from
   "always 2", because 2 is also desktopd's default. "switches to 1x" now also expects
   `{ ok: true, scale: 1, screen: { w: 1280, h: 800 }, hidpi: { ok: true } }` from the 1x cell's
   desktopd, through a small `desktopdHealth(port)` helper that asserts status 200.

Smaller differences:
- `xfconfInt` and `readXsettings` take an injected `Run`, so the gate is unit-testable.
- `readScreen` calls `execFile("xdpyinfo", [])` as the brief does.

### Ruling 3: exit statuses

Every probe whose output the new or changed tests read asserts its exit status. The vsync probes go
through `xfconf`, which is `outputAs` (exit 0). The process and license probes use `outputOf`
(exit 0). The fetches assert their HTTP status: 401 without the token, 200 with it, inside
`desktopdHealth`.

### Ruling 4

All Docker runs used `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>` with no `--`. The RED runs
added vitest's `-t <pattern>` and the GREEN runs added `--reporter=verbose`. No container connects
back to the test process, so no worker thread was needed.

## Residual notes (for Part 3)

- **A theoretical race on a session restart.** If `xfce4-session` exits in the milliseconds between
  desktopd's `pgrep` checks and its `xfconf-query`, the query could still hit the window. To do so,
  s6 would have to restart `svc-de` and `startwm.sh` would have to get through its X wait, its
  `xrandr` and its `pkill` loop (at least one 0.1 s sleep) before the query runs. That is
  practically unreachable, and untested because it is timing-bound.
- **No timeouts.** `/healthz` spawns two `pgrep`, two `xfconf-query` and one `xdpyinfo`, none with a
  timeout. Part 3's client should put its own timeout on the request.
- **A cell without a token.** desktopd exits 1 and s6 restarts it every second: 12 token errors in
  12 s in a token-less container, such as the "pinned tools" suite's. The session is unaffected. The
  token is required by design, so the orchestrator must always pass it.
- **Tearing.** Tearing without vsync is still unchecked (P3-C15's motion-capture check).

## Docker hygiene (after all runs)

```
$ docker ps -a --filter name=localdot-test
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker network ls --filter name=localdot-test
NETWORK ID   NAME      DRIVER    SCOPE
$ docker volume ls --filter dangling=true | count
23            (baseline 23)
```
- No `localdot-test-*` volumes remain.
- The manual-check resources were all removed with `docker rm -fv` / `docker volume rm -f`:
  `localdot-test-desktop-vsync`, `-boot`, `-boot1x`, `-notoken` and `localdot-test-desktop-boot-home`.
- The superseded builds `c1522d532570`, `5f92e3e0acb6` and `2f64cab7de24` no longer resolve. Only
  `6452129c4aab` is tagged `localdot/desktop:dev`.
- Nothing was pruned, and Docker was not restarted.

## Files changed

`4195ea0`:
- `cells/desktop/root/defaults/localdot/xfwm4.xml.in` (`vblank_mode` off)
- `apps/daemon/src/cells/desktop-image.docker.test.ts` (2x and 1x vsync probes)

`8e9262f`:
- `cells/desktop/desktopd/{package.json,tsconfig.json,build.mjs}`
- `cells/desktop/desktopd/src/{main,app,auth,xsettings}.ts` and
  `cells/desktop/desktopd/src/{app,xsettings}.test.ts`
- `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-desktopd/{type,run,dependencies.d/svc-de}` and
  `cells/desktop/root/etc/s6-overlay/s6-rc.d/user/contents.d/svc-desktopd`
- `cells/desktop/Dockerfile`, `cells/desktop/build.sh`, `cells/desktop/THIRD-PARTY.md`
- `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- `apps/daemon/src/cells/desktop-image.docker.test.ts`
