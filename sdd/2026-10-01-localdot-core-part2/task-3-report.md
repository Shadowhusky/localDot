# Task 3 report: one session D-Bus, HiDPI XFCE at 2x (1x switchable), locked Selkies settings

**Status: DONE_WITH_CONCERNS.** Every Run/Expected step passes. The concerns are seven deviations from
the brief, each forced by evidence or made to give a probe teeth, and they need the controller's
ruling. They are listed first.

Commit: `17a2d2a feat(desktop): one session bus, HiDPI XFCE at 2x and locked Selkies settings`
(on `feat/core-part2`, parent `c88b8a4`, empty body, no attribution line).

## Deviations from the brief (for a ruling)

Every file the brief gives verbatim is byte-identical to the brief, except
`registrymodifications.xcu`. A mechanical diff of the 7 blocks and the Dockerfile block against the
repo, run before the fix in item 1, printed "identical" for all of them.

1. **The brief's LibreOffice seed does not stop the "Welcome" dialog.** I added one item and a
   behaviour probe.
   - **The evidence (fresh container, fresh home, one launch each).**
     - With the brief's seed (`FirstRun=false` + `ShowTipOfTheDay=false`), LibreOffice 26.2 still
       opens the modal "Welcome to LibreOffice!" dialog. See RED-3: xdotool found window `35652259`.
     - The brief's own test only reads the file, so it passed while the dialog was up.
   - **Why the brief's keys miss it.** The pinned image's registry schema (`main.xcd`) says:
     - `/org.openoffice.Office.Common/Misc/FirstRun` only "Specifies if the office has never before
       been started". LibreOffice flipped the seeded `false` back to `true` after one run.
     - The dialog is What's New: `/org.openoffice.Setup/Product/WhatsNew`, "Set to false to not
       show the WhatsNew infobar on major updates".
   - **The fix.** One item added to the seed:
     `<item oor:path="/org.openoffice.Setup/Product"><prop oor:name="WhatsNew" oor:op="fuse"><value>false</value></prop></item>`,
     with a one-line XML comment saying why.
   - **Results.**
     - Every GREEN run shows neither the Welcome dialog nor Tip of the Day.
     - Two graceful quits (Ctrl+Q, so the profile is flushed) kept `WhatsNew=false`, `FirstRun=false`
       and `ShowTipOfTheDay=false`.
     - LibreOffice then records no `ooSetupLastVersion`, so a later LibreOffice major version in the
       image will not bring the dialog back in existing homes either.
   - **The test now proves the behaviour.**
     - It reads the three seeded values.
     - It launches Calc, waits for its window, then waits 5 s. The dialog follows the Calc window in
       about 0.8 s when it isn't suppressed.
     - It asserts `xdotool search --onlyvisible --name "Welcome to LibreOffice|Tip of the Day"` gives
       `{ status: 1, out: "" }` (xdotool's documented no-match).
     - It then quits LibreOffice and waits for it to exit, so later tests see a clean desktop. That
       matters for Task 3b's 2x screenshot, which is inserted after this test.
   - A hand-run A/B earlier pointed the same way, but it may be confounded: I re-seeded 2–3 s after
     `pkill`, and a dying LibreOffice can write its profile over the new seed. I rely only on the
     fresh-container runs above.
2. **`docker("logs", C2)` can never contain Selkies' startup line.**
   - Selkies logs to the container's **stderr**. `docker logs` replays that on its own stderr, and
     `docker()` returns stdout only. Checked by hand: the `Selkies 2.0.0 starting: …` line is on
     stderr only.
   - I added `dockerLogs(container)` to `testing/docker-cli.ts`. It joins both streams and throws on
     a non-zero exit. The test uses it.
3. **The page has no `selkies-core` text.**
   - The served `index.html` loads `./assets/index-CPWh3fQ6.js`, and that entry module does
     `import("./selkies-core-BbKps5RD.js")`. So the brief's check fails on the correct image.
   - The test now follows the entry module: it fetches it with auth, expects 200, and expects the
     text to contain `selkies-core`. If the regex found no entry, it fetches `/undefined` and gets a
     404, so the check is not vacuous.
4. **The 1x panel is 27 px, not 26.** The panel's X window is its xfconf `size` (26) + 1:
   - measured 27 at scale 1 on Task 2's image (both 2560 and 1280 wide) and on this image;
   - 54 at 2x, which is 2 × 27, so the brief's 2x value was right.

   The 1x expectation is now `{ WIDTH: 1280, HEIGHT: 27 }`, with a one-line comment at the 2x check.
5. **"switches to 1x" now really switches.**
   - Both desktops mount one named home volume, `localdot-test-desktop-home`, at `/config`. So C1
     starts on C2's 2x home, as a cell does when the orchestrator recreates its desktop on the same
     `localdot-home-<id>` volume (plan Task 8).
   - The brief's fresh 1x container could not catch a start script that writes the templates only
     on a first start, because a fresh home always takes the first-start branch. Mutation C proves
     the new form can.
   - `beforeAll`/`afterAll` remove the volume. Later tasks' edits to `startDesktop` (Task 5 adds
     `-p`/`-e` args) still apply.
6. **Probes made to test what their names say.**
   - **Exactly one session bus.** `pgrep -c -f "dbus-daemon.*--session"` replaces
     `"dbus-daemon --session"`. dbus-launch starts `dbus-daemon --syslog-only --fork … --session`,
     which the brief's pattern never matches: on Task 2's image it printed `0` while 2 session buses
     ran. The new pattern prints `2` there.
   - **AT-SPI on that bus.**
     - On Task 2's image, the brief's two probes passed even though AT-SPI sat on the dbus-launch
       bus.
     - I added `dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus
       org.a11y.Bus.GetAddress`.
     - Its reply must contain `string "<address>"`, where `<address>` is the one the root window's
       `AT_SPI_BUS` carries.
7. **The stream-socket test also checks the locks**, because the task title promises "locked Selkies
   settings" and nothing else checks them before Task 15.
   - Selkies sends a `server_settings` JSON on every new socket. The test asserts:
     - `scaling_dpi` is `{ value: "96", locked: true }`;
     - `enable_resize`, `use_css_scaling` and `enable_cursors` are each
       `{ value: false, locked: true }`;
     - `encoder.allowed` equals `["h264enc"]`.
   - Then it does the brief's 3 s hold, closes the socket and re-checks the two xfconf values.
   - Waiting for that message has a 15 s timeout, so a broken socket fails fast instead of hanging
     until the 600 s test timeout.
   - The handler is `ws.on("error")`, not `once`, so a late socket error cannot become an unhandled
     error.
   - The test is renamed "locks the scaling settings and keeps the HiDPI settings while a stream
     socket is open".

Ruling 1 is applied throughout:
- **Helpers.** `outputOf(container, …)` and `outputAs(container, user, …)` now take the container.
  Task 2's 11 calls pass `C`, and their behaviour is unchanged.
- **Probes with checked output.** Every one asserts its status: 0 through the helpers (`xfconf`,
  `panelGeometry`, `xprop`, `dbus-send`, `printenv`, `xdpyinfo`, `cat`).
- **"Nothing found" probes.** These assert the tool's documented status: `pgrep -c -x dbus-launch`
  → `{ status: 1, out: "0\n" }`, and `xdotool search` → `{ status: 1, out: "" }`.
- **Smaller changes.**
  - The basic-auth header is one `STREAM_AUTH` constant.
  - `panelGeometry`'s `pick` is a single anchored regex with the same semantics.

## What I implemented

- **Session bus (Step 1).**
  - `svc-session-bus` is an s6 longrun that runs
    `s6-setuidgid abc dbus-daemon --session --nofork --nopidfile --address=$DBUS_SESSION_BUS_ADDRESS`.
  - It depends on `init-services`, which comes after `init-selkies-config` and `init-nginx`, so it
    sees the full `container_environment`.
  - `svc-de` and `svc-selkies` depend on it, and it is in the `user` bundle.
- **Start script (Step 1).** `/defaults/startwm.sh` replaces the base's:
  - no `dbus-launch`;
  - copies the xfconf defaults (now with `thunar.xml`) and seeds the LibreOffice profile on the first
    start;
  - rewrites `xsettings.xml`/`xfwm4.xml` from the templates on every start (`LOCALDOT_SCALE` 1 →
    `Default`, 2 → `Default-xhdpi`, anything else exits 1);
  - kills any `xfconfd` that is already up, then execs `xfce4-session`.
- **Templates (Step 2).** `xsettings.xml.in`, `xfwm4.xml.in`, `registrymodifications.xcu` (item 1)
  and `xfce/thunar.xml`.
  - Note: besides `theme` and `title_font`, the brief's `xfwm4.xml.in` also sets
    `workspace_count` 4 → 1 and keeps one workspace name. Its prose mentions only the first two.
    Verbatim as given.
- **Dockerfile (Step 3).** `COPY root/ /`, the `RUN chmod 755` line (no earlier chmod line to keep)
  and the ENV block, verbatim, between the Cua Driver ENV and the `selkies-client` stage.
  `SELKIES_FILE_TRANSFERS` is set and empty in the image. `startwm.sh` and `run` are 100755 in git.
- **Test (Step 4).** Part 2 appended with the rulings and the deviations above. 13 tests in all (5 +
  8), as the brief expects.

## Build (Step 3 Run)

`BUILDKIT_PROGRESS=plain cells/desktop/build.sh` passed with exit 0.
- **Cached:** apt, Node, VSCodium, the pins COPY and pip.
- **Built:** only `#13 [base 7/8] COPY root/ /` and `#14 [base 8/8] RUN chmod 755 …`.
- A rebuild from the committed tree is fully `CACHED`, `COPY root/` included, so the tested image is
  the commit.
- **Final image:** `localdot/desktop:dev`. The ID moves with each provenance attestation; the content
  is that of `5588726afec1`.
- **Dangling images:** 0.

## Tests and results (TDD evidence)

All Docker runs used `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
apps/daemon/src/cells/desktop-image.docker.test.ts` (no `--`). The `-t` runs below are the same
command plus a name filter.

**RED-1: the new tests against Task 2's image** (`sha256:4fabab4f…`, before any change; the test
written first):
```
     × runs exactly one session bus at the fixed address and no dbus-launch
     × has AT-SPI on that bus
     × renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled panel
     × starts Selkies fixed at 2560x1600 with audio off and the stream behind basic auth
     × locks the scaling settings and keeps the HiDPI settings while a stream socket is open
     × opens Thunar in list view
     × seeds the LibreOffice profile so no first-run dialog appears
     × switches to 1x with LOCALDOT_SCALE=1
 AssertionError: expected '2' to be '1'                                   (session buses)
 AssertionError: expected 'method return time=… ' to contain 'string "unix:path=/config/.XDG/at-spi…'
 AssertionError: expected '1' to be '2'                                   (WindowScalingFactor)
 AssertionError: expected '[migrations] started\n…' to contain 'audio off'
 Error: Unexpected server response: 401
 AssertionError: xfconf-query -c thunar -p /default-view as abc: Property "/default-view" does not exist on channel "thunar". : expected 1 to be +0
 AssertionError: cat …/registrymodifications.xcu as abc: cat: …: No such file or directory : expected 1 to be +0
 AssertionError: expected 'Greybird-dark' to be 'Default'
      Tests  8 failed | 5 passed (13)
```

**GREEN-1 (first build) caught the brief's wrong expectations.**
```
     × starts Selkies fixed at 2560x1600 …  -> expected '<!doctype html><html lang="en"><head>…' to contain 'selkies-core'
     × switches to 1x with LOCALDOT_SCALE=1  -> expected [ { WIDTH: 10, HEIGHT: 10 }, …(1) ] to deep equally contain { WIDTH: 1280, HEIGHT: 26 }
      Tests  2 failed | 11 passed (13)
```
Items 3 and 4 above came out of this. Item 2 had already been fixed before the first run, from the
manual stderr check.

**RED-2/RED-3: the LibreOffice probes on the image with the brief's seed** (`sha256:54063509…`).
- Full run: `× seeds the LibreOffice profile …` →
  `expected '<?xml …' to contain '<prop oor:name="WhatsNew" …'`, `Tests 1 failed | 12 passed (13)`.
- Behaviour probe alone, with only the WhatsNew content line removed from a temporary copy
  (`-t "seeds the LibreOffice"`; file restored, `cmp` clean):
  ```
  × seeds the LibreOffice profile so no first-run dialog appears 6486ms
  AssertionError: xdotool search exits 1 when no window matches: expected { status: +0, out: '35652259\n' } to deeply equal { status: 1, out: '' }
  ```

**Audit A: each new assertion against Task 2's exact image.**
- **Setup.** Task 2's image was rebuilt from `git archive c88b8a4 cells/desktop` (all layers cached)
  as `localdot-test-desktop-task2` and tagged `localdot/desktop:dev` for the run. Every `expect` was
  made `expect.soft` in a temporary copy, so each failing assertion is listed. File restored, tag
  restored, `cmp` clean.
- **Totals:** `Tests 8 failed | 5 passed (13)`, with these failures:
  - **Session bus:**
    - `'2'` vs `'1'`
    - `{ status: +0, out: '2\n' }` vs `{ status: 1, out: '0\n' }` (dbus-launch)
    - `test -S` → 1
    - `printenv` → 1, `''`
  - **AT-SPI:** the GetAddress reply lacks the root address.
  - **2x:**
    - scaling `'1'`
    - theme `'Greybird-dark'`
    - panel lacks `{2560, 54}`
  - **Selkies:**
    - no `audio off`
    - authenticated page/script/health → 401
    - the script has no `selkies-core` (401 page)
  - **Socket:** 401.
  - **Thunar:**
    - `/default-view` missing
    - `/last-view` is `'ThunarIconView'`
  - **LibreOffice:**
    - no profile file (all 3 content checks)
    - a Welcome window was found (`48235605`)
  - **1x:** theme `'Greybird-dark'`.
- **Assertions that pass there, by design.** They are not change detectors:
  - `Xft/DPI` 96, and scaling 1 at 1x (the base defaults)
  - `xdpyinfo` dimensions and `fixed 2560x1600` (they come from the test's own env)
  - the unauthenticated 401s (the test passes `PASSWORD`)
  - the `unix:` root property and the single launcher
  - the 1x panel geometry

**Mutation B: lock assertions** (final image, `startDesktop` temporarily given
`SELKIES_ENABLE_RESIZE=false`, `SELKIES_USE_CSS_SCALING=false`, `SELKIES_ENABLE_CURSORS=false`,
`SELKIES_SCALING_DPI=` and `SELKIES_ENCODER=h264enc,jpeg`, soft expects, `-t "locks the scaling"`;
file restored, `cmp` clean). All five fail:
```
expected { Object (value, overridden, ...) } to match object { value: '96', locked: true }    (no lock)
expected { value: false, locked: false, …(1) } to match object { value: false, locked: true }   (×3)
expected [ 'h264enc', 'jpeg' ] to deeply equal [ 'h264enc' ]
```

**Mutation C: the 1x switch.**
- **The mutant.** It is the final image with `startwm.sh` sed-edited so the two template writes run
  only on a first start (`[ -n "${first:-}" ] && sed …`). It was built as
  `localdot-test-desktop-mutant`, tagged for the run, then the tag was restored.
- **The run.** Soft expects, `-t "switches to 1x"`.
- **The result:**
  ```
  AssertionError: expected '2' to be '1'
  AssertionError: expected 'Default-xhdpi' to be 'Default'
  AssertionError: expected [ { WIDTH: 20, HEIGHT: 20 }, …(1) ] to deep equally contain { WIDTH: 1280, HEIGHT: 27 }
  ```

**GREEN: final image and committed test, two runs with `--reporter=verbose`** (no stderr, warning or
unhandled-error lines in either log):
```
 ✓ … pinned tools > ships the app set 1011ms
 ✓ … pinned tools > ships Node 24.21.0 109ms
 ✓ … pinned tools > runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off 117ms
 ✓ … pinned tools > has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji 59ms
 ✓ … pinned tools > has the X, accessibility and certificate tools 216ms
 ✓ … session bus, HiDPI and Selkies > runs exactly one session bus at the fixed address and no dbus-launch 245ms
 ✓ … session bus, HiDPI and Selkies > has AT-SPI on that bus 183ms
 ✓ … session bus, HiDPI and Selkies > renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled panel 478ms
 ✓ … session bus, HiDPI and Selkies > starts Selkies fixed at 2560x1600 with audio off and the stream behind basic auth 61ms
 ✓ … session bus, HiDPI and Selkies > locks the scaling settings and keeps the HiDPI settings while a stream socket is open 3149ms
 ✓ … session bus, HiDPI and Selkies > opens Thunar in list view 127ms
 ✓ … session bus, HiDPI and Selkies > seeds the LibreOffice profile so no first-run dialog appears 6492ms
 ✓ … session bus, HiDPI and Selkies > switches to 1x with LOCALDOT_SCALE=1 7046ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  26.57s          (run 2: 13 passed, 26.62s)
```
The whole file takes about 27 s, not the brief's 2–3 minutes.

**Other checks on the committed tree:**
- `pnpm format`: "No fixes applied". An earlier run reflowed long lines in the test.
- `pnpm lint`: "Checked 59 files … No fixes applied."
- `pnpm typecheck`: all projects Done.
- `pnpm hygiene`: exit 0.
- `pnpm test`: 16 files, 145 tests passed.

## Manual verification (not in the test)

- **Process tree of a fresh container.** One `dbus-daemon --session … --address=unix:path=/tmp/localdot-session-bus`
  (pid 280), started before Selkies (322) and `xfce4-session` (395). The bus log shows
  xfce4-session's activations of `org.a11y.Bus`, `org.xfce.Xfconf`, `ca.desrt.dconf` and
  `org.freedesktop.Notifications` all going through it.
- **`docker restart`.**
  - The stale socket is replaced: a new bus pid, and the socket's mtime is 0.3 s after
    `StartedAt`.
  - There is 1 session bus and 0 dbus-launch.
  - The settings are scaling 2, DPI 96 and `Default-xhdpi`.
  - The GetAddress reply equals `AT_SPI_BUS`.
- **The session bus killed mid-session.**
  - s6 restarted `svc-session-bus` (pid 262 → 835).
  - `xfce4-session` died, and `svc-de` restarted it (366 → 859), with the panel back.
  - There is still 1 session bus and 0 dbus-launch, and the settings are intact.
- **Selkies on startup.** At DPI 96 on a fresh or reused home, `restore_dpi` writes nothing and
  `set_cursor_size` is skipped (`XCURSOR_SIZE` unset → -1). So in practice nothing activates an
  early `xfconfd`, and the `pkill` in `startwm.sh` is defensive.

## Files changed (17a2d2a)

```
 apps/daemon/src/cells/desktop-image.docker.test.ts | 250 +++++++++++++++++++--
 apps/daemon/src/cells/testing/docker-cli.ts        |   7 +  (dockerLogs)
 cells/desktop/Dockerfile                           |  32 +++
 cells/desktop/root/defaults/localdot/registrymodifications.xcu    |   7 +
 cells/desktop/root/defaults/localdot/xfwm4.xml.in                 |  88 ++++++++
 cells/desktop/root/defaults/localdot/xsettings.xml.in             |  25 +++
 cells/desktop/root/defaults/startwm.sh                            |  29 +++  (100755)
 cells/desktop/root/defaults/xfce/thunar.xml                       |   6 +
 cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/run     |   5 +  (100755)
 cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/type    |   1 +
 + 4 empty s6 marker files (svc-session-bus/dependencies.d/init-services,
   svc-de/dependencies.d/svc-session-bus, svc-selkies/dependencies.d/svc-session-bus,
   user/contents.d/svc-session-bus)
 14 files changed, 435 insertions(+), 15 deletions(-)
```

## Self-review findings

- **Complete.** All six steps are done:
  - files and templates, verbatim apart from deviation 1;
  - the Dockerfile block, verbatim and in place;
  - the build reused the cached layers;
  - 13 tests;
  - the commit.
- **Interfaces as the brief states.**
  - `DBUS_SESSION_BUS_ADDRESS` reaches every process, `docker exec` included.
  - `LOCALDOT_SCALE` 1|2 is the default 2 with 2560×1600.
  - nginx basic auth uses the user `localdot`.
  - `/api/websockets` sits behind it.
- **Quality and YAGNI.** The only code beyond the brief is the deviations above, each tied to
  evidence. Comments are added only where a value would otherwise puzzle a reader:
  - why the session-bus pattern is broad;
  - why the panel is 27/54;
  - how the page reaches `selkies-core`;
  - the LibreOffice timing;
  - the shared home;
  - the `dockerLogs` streams;
  - the xcu's `WhatsNew`.
- **Tests verify behaviour.** Every new assertion has been seen failing for its own reason: RED-1,
  RED-2/3, audit A and mutations B and C. Output is pristine.
- **Docker hygiene (final):**
  ```
  $ docker ps -a --filter name=localdot-test
  CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
  $ docker network ls --filter name=localdot-test
  NETWORK ID   NAME      DRIVER    SCOPE
  $ docker volume ls --filter dangling=true      -> 23 volumes, the same names as my pre-task snapshot (diff empty)
  $ docker volume ls --filter name=localdot-test -> header only
  dangling images: 0; localdot-test-* images: 0 (keep/task2/mutant tags removed; localdot/desktop:dev = final build)
  ```
  - **Names.** Every container I made was named `localdot-test-*` and removed with `-fv` or `--rm`.
  - **Shared resources.** Nothing was pruned, and no other project's resource was touched.
  - **Bind mounts.** None. Selkies' source came out with `docker cp`, and Task 2's tree came out
    through `git archive` into the scratchpad as a build context.

## Concerns and notes for the controller

1. **Rule on deviations 1–7.** Item 1 changes a verbatim file. Item 5 changes the test's container
   setup. The others correct or strengthen probes.
2. **Plan sync for later tasks.** Tasks 3b, 5 and 15 quote this test, and the plan's Task 3 text
   (≈ lines 880–1240) no longer matches it in these places:
   - the helper signatures (container first);
   - `dockerLogs`;
   - 1x panel 27;
   - the page check;
   - `WhatsNew`;
   - the shared home volume;
   - the socket test's name.
   Task 3b's instructions still apply as written: change the two theme strings, and add tests before
   "switches to 1x". Its look-1x screenshot will now come from the switched home.
3. **Optional hardening, not done.**
   - `svc-session-bus` has no s6 readiness notification. s6 marks it up when spawned, not when the
     socket is bound.
   - The bus started first in every run, and `svc-de` waits for X first. A lost race would only
     delay the desktop, because `svc-de` is supervised: it restarts after `xfce4-session` exits, as
     the bus-kill test showed.
   - Closing it fully is `notification-fd` = 3 plus `--print-address=3` on the `dbus-daemon` line.
4. **Observation.** The brief's `startwm.sh` no longer sends `xfce4-session`'s output to
   `/dev/null` as the base did, so the desktop's GTK and xfce warnings now appear in `docker logs`.
   This is harmless and useful for diagnosis.

## Fix report: task review round 1 (four Minors the controller ruled fixed now)

**Status: DONE.** Commit:
`f779c3f fix(desktop): lock every Selkies switch and stop xfconfd before the HiDPI rewrite`. It is a
new commit on top of `17a2d2a`, with an empty body and no attribution.
- **Diffstat:** 9 files, 95 insertions, 33 deletions.
- **The tested image is the commit:** a rebuild from it is fully `CACHED`. The final image is
  `localdot/desktop:dev` `sha256:c21c8b35…`, with the same layers as the tested `440b0e48…`.

### Finding 1: `startwm.sh` now stops xfconfd, and waits, before the rewrite

**The change.** Before the two `sed` lines it runs
`if pkill -u "$(id -u)" -x xfconfd; then while pgrep -u "$(id -u)" -x xfconfd >/dev/null; do sleep 0.1; done; fi`.
The `pkill` after the `sed` lines is gone, and the comment now says why: a leftover xfconfd flushes
its pending changes as it exits, and serves stale values while it dies.

**RED (pre-fix image `eba127f…`).** The experiment:
- As `abc`, set `xsettings /Gdk/WindowScalingFactor` to 1 and `xfwm4 /general/theme` to `Default`,
  then `pkill -x xfce4-session`, all in one exec.
- `svc-de` restarted the session within about 1 s, inside xfconfd's 5 s write timeout.

The result:
```
before:          xfconf: scale=2 theme=Default-xhdpi; files: 2 Default-xhdpi
session back as 994 after ~1s; xfconfd now 1016
after restart:   xfconf: scale=1 theme=Default;       files: 1 Default
```
The dying xfconfd flushed the changed values over the fresh templates.

**GREEN (fixed image `440b0e48…`).** The same experiment, twice:
```
round 1: session 390 -> 927 after ~2s; xfconfd 412 -> 954   after: scale=2 theme=Default-xhdpi; files: 2 Default-xhdpi
round 2: session 927 -> 1196 after ~2s; xfconfd 954 -> 1223  after: scale=2 theme=Default-xhdpi; files: 2 Default-xhdpi
```
- **Not an automated test.** The ruling asked for a proof, and the bug only shows when the restart
  lands inside the 5 s write window, so a test of it would be timing-bound.
- **Note.** The wait loop has no upper bound, as specified. An xfconfd that ignored SIGTERM would
  hold the session start; I did not see one.

### Finding 2: every Selkies switch the image sets is locked, and the socket test asserts each one

**Method.** I read Selkies 2.0.0's `settings.py`:
- **Bools** take `|locked`.
- **Ranges.** A bare `60` keeps the built-in span 8–240; `60-60` is a one-value span, which locks
  it.
- **Enums.** A single item locks.
- **`str` and `list` settings** carry no lock. `sanitize_client_setting` would accept any client
  value for them, but neither transport takes one:
  - the websocket `SETTINGS` parser and WebRTC's `settings_allowed_to_update` list only video, rate
    and size keys plus `enable_binary_clipboard`;
  - the clipboard policy is fixed when the input handler is built, and every client→server clipboard
    message checks `enable_clipboard in ["true","in"]`;
  - uploads and downloads check `"upload"/"download" in settings.file_transfers`.
- **Off is not always off.** `webcam_locked_off()` refuses the camera uplink only when the switch is
  locked and off, and an unlocked off microphone is just the client's toggle. So for those two, the
  lock is the real off switch.

The table was read from the `server_settings` payload of a running container (scratchpad
`dump-settings.mjs`).

| Setting | Before (`eba127f`) | After (final) | Dockerfile now |
|---|---|---|---|
| framerate | `[8,240]` min 8 max 240 (unlocked) | `[60,60]` min 60 max 60 | `60-60` |
| video_fullcolor | true, locked false | true, locked true | `"true\|locked"` |
| audio_enabled | false, locked false | false, locked true | `"false\|locked"` |
| microphone_enabled | false, locked false | false, locked true | `"false\|locked"` |
| webcam_enabled | false, locked false | false, locked true | `"false\|locked"` |
| gamepad_enabled | false, locked false | false, locked true | `"false\|locked"` + `init-gamepad-lock` (below) |
| printing_enabled | false, locked false | false, locked true | `"false\|locked"` |
| command_enabled | false, locked false | false, locked true | `"false\|locked"` |
| ui_show_sidebar / ui_show_core_buttons / ui_show_logo | false, locked false | false, locked true | `"false\|locked"` |
| **file_transfers** | **`["upload","download"]` (enabled!)** | `[]`, allowed `[]` | `none` |
| enable_clipboard | `"false"`; clipboard_enabled/in/out all false; no lock in 2.0.0 | unchanged | `false` (kept) |
| enable_resize / use_css_scaling / enable_cursors | false, locked true | unchanged | unchanged |
| scaling_dpi | "96", locked true, allowed ["96"] | unchanged | unchanged |
| encoder | "h264enc", allowed ["h264enc"] | unchanged | unchanged |
| manual_resolution | true, locked true | unchanged | (from MANUAL_WIDTH/HEIGHT) |
| enable_binary_clipboard | true, locked false | unchanged | not set by the image (see notes) |

**Two findings this surfaced, beyond the review.**

1. **File transfers were enabled.** The image's `SELKIES_FILE_TRANSFERS=` (empty) becomes a 0-byte
   `/run/s6/container_environment/SELKIES_FILE_TRANSFERS`. s6's envdir unsets a variable whose file
   is empty, so Selkies' process environment had no `SELKIES_FILE_TRANSFERS` (checked in its
   `/proc/<pid>/environ` as `abc`).
   - Selkies then fell back to its default, `upload,download`.
   - Any client holding the stream password could upload into, and download from, the cell.
   - Fixed with `none`, which the 2.0.0 list parser treats as "disable".
2. **Gamepad: the Dockerfile alone cannot lock it.**
   - With `NO_GAMEPAD=1`, the base's `init-selkies-config` writes a plain `false` into
     `container_environment` after the image ENV. Built with only the Dockerfile change, the payload
     still read `gamepad_enabled {"value":false,"locked":false}` and the env file read `[false]`.
   - Dropping `NO_GAMEPAD` would instead create fake joystick devices and put Selkies'
     input-interposer `LD_PRELOAD` into every desktop app.
   - So I added a small s6 oneshot, `init-gamepad-lock`. It depends on `init-selkies-config`, and
     `svc-selkies` depends on it.
   - It writes `false|locked` back into that one file. After it, the env file reads
     `[false|locked]`, Selkies' environ shows `SELKIES_GAMEPAD_ENABLED=false|locked`, and the payload
     reports locked true.
   - Its `run` is on the Dockerfile's `chmod 755` line, which keeps both earlier paths (Ruling 4),
     and is 100755 in git.
   - Security-wise, gamepad input was already dropped server-side while the value is false
     (input_handler: "Enforced server-side…"), so this oneshot only makes the lock real. Veto it if
     you'd rather keep the image at Dockerfile-only changes; the test would then assert gamepad's
     value only.

**The startup line now reads** `encoder h264enc at 60 fps, fixed 2560x1600, audio off, gamepads off,
access open` (it was `at 8-240 fps`).

**Test change.** The socket test (renamed "locks every Selkies switch and keeps the HiDPI settings
while a stream socket is open") asserts:
- `{ value: false, locked: true }` for each of the 12 bool off switches above;
- `video_fullcolor` and `manual_resolution` at `{ value: true, locked: true }`;
- `scaling_dpi` locked;
- `framerate` at `{ value: [60, 60], min: 60, max: 60 }`;
- `encoder` at `{ value: "h264enc", allowed: ["h264enc"] }`;
- `enable_clipboard` `"false"`, with all three derived clipboard flags false;
- `file_transfers` at `{ value: [], allowed: [] }`.

Two one-line comments say why ranges and enums have no `locked` flag, and why the clipboard and
file-transfer policies have none.

**RED.** The new assertions, made soft, against the pre-fix image, run with `-t "locks the scaling"`
(the old name). Twelve failed:
```
audio_enabled / microphone_enabled / webcam_enabled / gamepad_enabled / printing_enabled / command_enabled /
ui_show_sidebar / ui_show_core_buttons / ui_show_logo: expected { value: false, locked: false, …(1) } to match object { value: false, locked: true }
expected { value: true, locked: false, …(1) } to match object { value: true, locked: true }        (video_fullcolor)
expected { value: [ 8, 240 ], …(4) } to match object { value: [ 60, 60 ], min: 60, max: 60 }     (framerate)
expected { …(3) } to match object { value: [], allowed: [] }                                     (file_transfers)
      Tests  1 failed | 12 skipped (13)
```

**Trade-off to know about (requested by the review, so kept).** With `video_fullcolor` locked on and
`h264enc` the only allowed encoder, a viewer whose decoder lacks H.264 4:4:4 has no encoder to step
down to. Chrome decodes it in software (S1), so the Part 2 viewer is unaffected.

### Finding 3: the stream refuses a socket without credentials

`upgradeOutcome(url)` opens a WebSocket with no headers and resolves with `"open"` or with ws's error
message, then terminates the socket either way. The basic-auth test now asserts
`expect(await upgradeOutcome("ws://127.0.0.1:<port>/api/websockets")).toBe("Unexpected server response: 401")`.

**RED.** A mutation: `startDesktop` without `PASSWORD`, so nginx has no basic auth. Soft asserts,
`-t "behind basic auth"`:
```
AssertionError: expected 200 to be 401        (existing unauthenticated page check)
AssertionError: expected 200 to be 401        (existing unauthenticated health check)
AssertionError: expected 'open' to be 'Unexpected server response: 401'
```
The test file was restored and `cmp` was clean.

### Finding 4: socket-test hygiene

- **`serverSettings`.**
  - It uses a named `onMessage` that is removed with `ws.off` once the settings arrive.
  - `JSON.parse` sits inside try/catch, and `msg?.type` guards a JSON `null`. Selkies' other text
    messages, such as `MODE websockets` and `DISPLAY_CONFIG_UPDATE,…`, aren't JSON.
  - The error listener stays, so a late socket error cannot be unhandled.
- **Entry module.** The test asserts the regex matched (`expect(entry, html).toBeDefined()`) before
  fetching the module.
- **No blocking sleep.** `sleepSync(3000)` is now `await sleep(3000)`, using `node:timers/promises`.
  `sleepSync` remains only in `startDesktop` and the LibreOffice wait, where no socket is open.
- **RED.** These are guards and refactors with no behaviour to turn RED. The GREEN runs below cover
  them.

### Manual check: AT-SPI after the session bus is killed and recovers

It **matches**. I did not change anything for this.
- **Before (final image):** the root window's `AT_SPI_BUS` equals `GetAddress` on the fixed bus:
  `unix:path=/config/.XDG/at-spi/bus_1,guid=7c721bc1…`. One launcher, one a11y bus, one registryd,
  one session bus, 0 dbus-launch.
- **After `pkill -f 'dbus-daemon --session'` + 15 s, done twice:**
  - Both times there was a new guid (`cffb16f2…`, then `22e4a15d…`), with the root property equal to
    `GetAddress`.
  - Both times there was one of each process and 0 dbus-launch, scale 2, and the panel was back.
- **The old launcher** exited with its bus, and everything AT-SPI was respawned with the new session.
- **The pre-fix image** gave the same result.

### Verification

- **Docker suite:** `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
  apps/daemon/src/cells/desktop-image.docker.test.ts` with `--reporter=verbose`, run three times on
  the final image: `Tests 13 passed (13)`, 26.5 s each, and 0 stderr/warning/unhandled lines. Run 3
  was after the rename:
  ```
  ✓ … > locks every Selkies switch and keeps the HiDPI settings while a stream socket is open 3139ms
  Test Files  1 passed (1)
       Tests  13 passed (13)
  ```
- **Repo checks:**
  - `pnpm format`: "No fixes applied".
  - `pnpm lint`: "Checked 59 files … No fixes applied."
  - `pnpm typecheck`: exit 0.
  - `pnpm hygiene`: exit 0.
  - `pnpm test`: 16 files, 145 tests passed.
- **Docker hygiene after the round:**
  ```
  $ docker ps -a --filter name=localdot-test
  CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
  $ docker network ls --filter name=localdot-test
  NETWORK ID   NAME      DRIVER    SCOPE
  dangling volumes: 23 (the same set as the pre-task snapshot); localdot-test volumes: 0;
  dangling images: 0; localdot-test images: 0
  ```

### Files changed (f779c3f)

```
 apps/daemon/src/cells/desktop-image.docker.test.ts | 82 ++++++++++++++++++----
 cells/desktop/Dockerfile                           | 32 +++++----   (locking forms, FILE_TRANSFERS=none, chmod line)
 cells/desktop/root/defaults/startwm.sh             |  8 ++-        (stop and wait for xfconfd before the rewrite)
 cells/desktop/root/etc/s6-overlay/s6-rc.d/init-gamepad-lock/{type,up,run,dependencies.d/init-selkies-config}
 cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-selkies/dependencies.d/init-gamepad-lock
 cells/desktop/root/etc/s6-overlay/s6-rc.d/user/contents.d/init-gamepad-lock
 9 files changed, 95 insertions(+), 33 deletions(-)
```

### Notes for the controller

1. **The `file_transfers` finding** goes beyond the review and is security-relevant. Before
   `f779c3f`, every cell built from `17a2d2a` accepted uploads and downloads from any client holding
   the stream password.
2. **`init-gamepad-lock`** is the one change outside the Dockerfile. Veto it if unwanted; reasons
   above.
3. **`enable_binary_clipboard`** (true, unlocked) is not set by the image. While the clipboard policy
   is `false`, every clipboard message is refused in both directions, so I left it alone.
4. **Plan sync** for later tasks, in addition to the list in the first report:
   - the socket test's new name;
   - the new helpers `upgradeOutcome` and the reworked `serverSettings`;
   - `SELKIES_FRAMERATE=60-60`, `SELKIES_FILE_TRANSFERS=none` and the `|locked` forms;
   - the `init-gamepad-lock` oneshot and the extra path on the `chmod` line.
