# Task 3b report: the macOS look (WhiteSur light, WhiteSur icons, Plank, menu-bar panel)

**Status: DONE_WITH_CONCERNS.** Every brief step passes, and the brief's own screenshot check is the
reason for most of what follows. The image built from the brief plus D1, the Apple-logo removal
(`e348d00e`, "brief + D1"; corrected in fix round 1), passed a 16-test suite, but its 2x screenshot
showed these problems:
- a dark menu bar;
- GTK's red "image-missing" sign where the menu button should be;
- the actions plugin's "abc", clipped against the screen edge;
- Plank drawn as an opaque grey square with ImageMagick's wizard icon in it.

Deviations D1–D10 below fix these and the no-Apple-artwork rule. Each comes with evidence, and each
needs a ruling.

Commit: `11ddf3e feat(desktop): WhiteSur light look with Plank and a menu-bar panel` (on
`feat/core-part2`, parent `f779c3f`, empty body, no attribution line). 10 files, 346 insertions,
30 deletions.

## Deviations from the brief (for a ruling)

**D1. Apple logos removed (global constraint: no Apple fonts or artwork).**
- The release's `gnome-shell/assets/activities.svg` and `activities-white.svg` are the Apple logo
  ("Start icon style: apple" in `release-info.txt`).
- In the icon theme, Quick Look renders of every candidate confirmed the Apple logo in
  `places/{16,22,24,scalable}/start-here.svg`, `places/scalable/start-here-symbolic.svg`,
  `status/{16,22,24}/start-here-symbolic.svg`, `status/32/start-here.svg`,
  `status/symbolic-budgie/…` and `places/{16,symbolic}/folder-apple*.svg`. 27 links point at them,
  including `status/*/xfce4-whiskermenu.svg`.
- Not Apple artwork, checked by rendering: `folder-mac` (an X window glyph), the mac/apple mime
  icons and the iPhone/iPad device links (generic icons), `tapple` (a fruit).
- The installer's `-p` option only swaps the `places` logos for KDE's, so it isn't enough.
- **Fix:**
  - The GTK RUN deletes `WhiteSur-Light/gnome-shell`; this desktop has no GNOME Shell.
  - The icon RUN deletes `start-here.svg`, `start-here-symbolic.svg`, `folder-apple*` and links
    targeting `start-here*` from the clone **before** `install.sh`. The installer's
    `gtk-update-icon-cache` therefore indexes a consistent tree, and `find -L` shows 0 dangling
    links in all three icon themes.
- **New test** "ships WhiteSur without its Apple logos": the suite now has 16 tests, not the
  brief's 15.

**D2. The GTK theme is the release's `WhiteSur-Light-solid` build, installed as `WhiteSur-Light`.**
- **The cause.** The brief's `WhiteSur-Light.tar.xz` styles the XFCE panel with
  `background-color: rgba(255, 255, 255, 0.155); color: white` (read from the gresource in the
  image).
  - With no compositor, the 15.5 % tint is drawn over black, so the bar is `srgb(39,39,39)`.
  - With a compositor, it is a faint tint over the wallpaper with white text. That reads only on a
    dark wallpaper, so it can never be the brief's "light top panel" (P2-R12).
- **The fix.** `Light-solid` gives `.xfce4-panel.background { background-color: #f1f1f1; color:
  #363636 }`. Its file list, `xfwm4/` and `plank/dock.theme` are byte-identical to `Light`; only the
  two gresources differ. Menus are opaque in both builds; popovers are 0.96.
- **Naming.** `tar --transform` installs it under the `WhiteSur-Light` name, so every interface
  name in the spec, the plan and the tests stays the same. Its `index.theme` still says
  `Name=WhiteSur-Light-solid`, which is cosmetic: GTK and xfwm4 use the directory name.
- **The alternative** is the honest upstream name, `WhiteSur-Light-solid`, but that renames the
  GTK and 1x xfwm4 themes.

**D3. `use_compositing` true, following the brief's own conditional step.**
- **Why.** Plank drew an opaque, square-cornered `srgb(123,123,123)` block: the theme's alpha-150
  fill drawn over black. With xfwm4's compositor it is WhiteSur's translucent rounded dock.
- **CPU**, measured with `docker stats --no-stream`: 8 samples per run while 600
  `xdotool windowmove` calls drag a Thunar window (about 33 moves/s), with no Selkies client
  connected.

  | Image | Idle, compositor off | Idle, compositor on | Drag load, off | Drag load, on |
  |---|---|---|---|---|
  | final `1d66339f` | — | 0.41–0.89 % | 23.8 % / 25.1 % (two runs) | 27.8 % / 28.0 % |
  | brief + D1 `e348d00e`, toggled live | 0.47–0.59 % | 0.46–0.62 % | 24.5 % / 24.8 % | 26.7 % / 28.2 % |

  So the cost is **+3.4 points (about +14 %) under continuous window drags and nothing at idle**.
  The brief asks for this in the Task 15 measurement note, a file that doesn't exist yet; the
  numbers are here for Task 15.
- **Stream risk checked.** pixelflux captures on X DAMAGE.
  - With a python-xlib `DamageReportRawRectangles` on the root window over 60 window moves, the
    root got **61** DAMAGE events with the compositor (one merged repaint per move) and **543**
    without it.
  - So a damage-driven capture still sees every change. A real Selkies frame count under the
    compositor is left to Task 15 (or Task 4).

**D4. Menu button icon: `distributor-logo` → `view-app-grid-symbolic`.**
- WhiteSur has no plain `distributor-logo` (only `distributor-logo-<distro>`), and it inherits
  only `hicolor,breeze`. The brief's button therefore showed GTK's red "missing image" sign.
- The app-grid glyph is WhiteSur's own symbolic icon and renders `#363636` on the light bar.
- **New probe:** the configured `button-icon` must exist as an SVG in WhiteSur. On the brief + D1
  image, `find … -name distributor-logo.svg` prints nothing; that was shown by hand. The recorded
  RED is the panel mutation in fix round 1.

**D5. No actions (session) plugin; 8 px transparent separators at both ends; plugins renumbered.**
- The brief's actions plugin printed "abc", the base's account name, flush against the right edge
  with no gap after the clock.
- XFCE 4.20 has no icon-only title. Its `title-store` lists Full Name, Username, User ID and
  Custom; `button-title` 4 is rejected with a GLib-CRITICAL.
- Its button mode drew only a faint, insensitive logout icon, because the cell has no logind:
  `CanShutdown` is false.
- A working log-out would only end the agent's session.
- Without the plugin the clock sat flush against the edge (after a panel restart), so a
  transparent separator at each end gives 8 logical px.
- The bar now reads: app grid · expanding separator · tray · volume · clock. The Interfaces'
  "actions" item is gone.

**D6. The dock's items are pinned.**
- **Before:** Plank's first-run defaults come from MIME handlers: Chromium, VSCodium and
  ImageMagick's `display` (the wizard icon).
- **The launcher.** `localdot-plank` now rewrites `~/.config/plank/dock1/launchers` and the
  `dock-items` key on every start, as it already does for the look. The items are the spec's apps:
  Files (Thunar), Chromium, Terminal, VSCodium, Mousepad, Writer, Calc, Impress and GIMP.
- **Thunar's windows.** The base runs Thunar as `thunar-real` behind a wrapper, so its windows
  carry `WM_CLASS thunar-real/Thunar-real`. BAMF matched them to no desktop file, so Plank added a
  second, blurry Thunar item.
- **The fix:** `StartupWMClass=Thunar-real` is sed-inserted into `thunar.desktop` in the Plank
  layer, *before* `apt-get install plank`. bamfdaemon's postinst then indexes it (`bamf-2.index`:
  `thunar.desktop thunar %U Thunar-real`).
- **Verified live:** after the fix, the open window lights the pinned Files item, with a running
  dot and no duplicate.
- **New probe:** every launcher resolves to an existing `.desktop` file, nine in all.

**D7. The dock assertion pins the strut, not the window.**
- With the compositor, Plank's X window is 2560×324 at (0,1276) at 2x and 1280×162 at (0,638) at
  1x: room for the icon bounce.
- Plank input-shapes that window to the dock itself: 1132×132 at x=714, centred
  (python-xlib `shape_get_rectangles(Input)`).
- The pointer at (1280, 1300/1400/1460) resolves to xfdesktop and at (1280, 1500) to Plank, so
  clicks above the dock pass through.
- The test asserts that the window touches the bottom edge, and the strut: 132 at 2x and 66 at 1x,
  which is the 48 px icon size.

**D8. Test helper.** Task 3's `panelGeometry` is replaced by `dockWindow(name, classname)`. It
returns x, y, width, height and `_NET_WM_STRUT_PARTIAL` for the panel (both scales, exact) and for
Plank (both scales).

**D9. The screenshot opens a window.**
- The brief's check, "traffic-light buttons on the left of the title bar", needs a window on
  screen. `saveLook` opens Thunar, waits until it is visible, captures, checks the PNG size, copies
  it out, then closes the window with `xdotool windowactivate --sync … key ctrl+w`.
- `pkill -x thunar` fails here, because the session's `thunar-real --daemon` owns the window.
  Killing it would take the file-manager daemon down.

**D10. Small ones.**
- **ARGs.** Each pin pair sits directly above its own RUN (Task 2's deferred Minor), so an
  icon-pin bump does not rerun the GTK or Plank layers.
- **The table in the image.** `THIRD-PARTY.md` is also copied into
  `/usr/share/doc/localdot-themes/`, so the image carries the modification notes that GPL-3.0 §5a
  asks for on the icon theme.
- **Plank's license** is recorded as GPL-3.0-or-later, from Debian's `copyright` file (`GPL-3+`).

## The menu-bar panel's measured height

The panel config is the brief's (`size` 26, `icon-size` 16), and these values were measured
identically on the brief + D1 image (`e348d00e`) and on the final one.

| Scale | Window | Strut (`_NET_WM_STRUT_PARTIAL`) |
|---|---|---|
| 2x | 2560×54 at (0,0) | `0, 0, 54, 0, 0, 0, 0, 0, 0, 2558, 0, 0` |
| 1x | 1280×27 at (0,0) | `0, 0, 27, 0, 0, 0, 0, 0, 0, 1279, 0, 0` |

**So it is 27 px at 1x and 54 px at 2x**, for both the window and the strut, as Task 3 measured. The
brief's 26 and the plan's Part 3 mapping line ("26 px (1×) / 54 px (2×) strut") are one pixel off
at 1x. The test asserts both rows exactly.

## Tests and results

All Docker runs used `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
apps/daemon/src/cells/desktop-image.docker.test.ts`, with no `--`.

### RED-1: the first test version against Task 3's image

`c21c8b35`, before any image change: **6 failed | 10 passed (16)**.

```
× renders HiDPI XFCE at 2x …         expected 'Default-xhdpi' to be 'WhiteSur-Light-xhdpi'
× locks every Selkies switch …       enable_binary_clipboard: expected { value: true, locked: false, … } to match object { value: false, locked: true }
× wears the WhiteSur light look …    expected 'Greybird-dark' to be 'WhiteSur-Light'
× ships WhiteSur without its Apple logos   find: '/usr/share/themes/WhiteSur-Light': No such file or directory … expected 1 to be +0
× saves a 2x screenshot …            pkill -x thunar as abc: expected 1 to be +0   (my helper's bug → D9)
× switches to 1x …                   expected 'Default' to be 'WhiteSur-Light'
```

### The brief + D1 image

The brief + D1 image (`e348d00e`: the brief's files plus D1's Apple-logo removal, and D10's
layout-only changes) passed all 16 tests, so the screenshot was the only gate that caught its
defects. *(Fix round 1: this section was labelled "brief-verbatim", which was wrong.)*

### Audit A: the test file of that point, every assertion soft, against Task 3's image

The method: a temporary copy with every `expect` made `expect.soft`, run with `-t "session bus,
HiDPI and Selkies"`. The copy was deleted afterwards. **5 failed | 6 passed**; each assertion in
the file at that point failed for its own reason. *(Fix round 1 correction: the no-actions and
menu-icon probes were added after Audits A and B, so neither audit ran them. See fix round 1 for
their RED.)* The failures:
- `Default-xhdpi` for the 2x theme;
- `enable_binary_clipboard {true, unlocked}`;
- `Greybird-dark`, `elementary-xfce-dark` and `O|SHMC` for the three theme names;
- `ls` exit 2 for the missing files;
- both `identify` probes: the image is missing;
- `tasklist` present;
- bar pixel `srgb(59,62,63)`;
- compositor `False`;
- `pgrep plank` exit 1;
- `gsettings`: "No such schema net.launchpad.plank.dock.settings";
- "timed out waiting for plank";
- Apple-logo `find` exit 1;
- 1x theme `Default`, and "timed out waiting for plank" again.

The screenshot test passes on any desktop, by design; it is not a look probe.

### Audit B: the same soft copy against the brief + D1 image

`e348d00e`. **1 failed** test, with exactly the three deviation probes the file had then failing:

```
expected 'srgb(39,39,39)' to be 'srgb(241,241,241)'      (D2: dark bar)
expected 'False' to be 'True'                             (D3: no compositor)
expected [ …(3) ] to deeply equal [ …(9) ]                (D6: Plank's 3 default launchers)
```

D4's probe was shown only by hand at this point, not in a recorded test run:
- on the brief + D1 image, `find /usr/share/icons/WhiteSur/ -name distributor-logo.svg` prints
  nothing;
- on the final image, `…/actions/symbolic/view-app-grid-symbolic.svg`.

D5's no-actions probe was not shown failing at all until fix round 1.

The panel and Plank strut assertions pass on both builds. They are geometry contracts for Part 3,
not change detectors.

### My own wrong expectations, corrected to measurements

- The 1x panel strut end: I predicted `1278`; the measurement is `1279`.
- The Plank window: I first asserted a 132 px window. Under the compositor it is 324 px, so the
  assertion became the bottom edge plus the strut (D7).

### Ruling 5a: the bounded xfconfd wait

The method: a fake `xfconfd` (a renamed `bash` with SIGTERM ignored) in a throwaway container from
the final image. The new lines were taken verbatim from the image's `/defaults/startwm.sh`.

```
OLD loop (f779c3f): exit 124 (killed by timeout) after 15.00 s; xfconfd still there (pid 8)
NEW loop:           exit 0 after 5.422 s; xfconfd gone (SIGKILLed)
NEW loop, an xfconfd that exits on SIGTERM: exit 0 after 0.008 s; gone
NEW loop, no xfconfd: exit 0 after 0.009 s
```

### Rulings 5b–5d

- **5b.** `upgradeOutcome` now passes `{ handshakeTimeout: 15_000 }`. This is a guard with no
  behaviour to turn RED; the 401 assertion still passes.
- **5c.** The Dockerfile's lock comment now reads "The Selkies values set here that a client could
  change are locked".
- **5d.** `SELKIES_ENABLE_BINARY_CLIPBOARD="false|locked"` (a Selkies bool, per `settings.py`) is
  asserted in the lock list. It was RED in RED-1.

### GREEN

16/16 on every final build:

| Image | Runs | When |
|---|---|---|
| `1d66339f` | 1 | the build after D1–D9 |
| `5754f42b` | 2 | after the `THIRD-PARTY.md` reflow |
| `9d03f9a5` | 1 | rebuilt from commit `11ddf3e`, every step `CACHED` |

- Each run took about 40 s.
- The logs had 0 stderr, warning or unhandled-error lines.
- The `9d03f9a5` run:

```
 ✓ … pinned tools (5 tests)
 ✓ … runs exactly one session bus … / has AT-SPI … / renders HiDPI XFCE at 2x … 532ms
 ✓ … starts Selkies fixed … / locks every Selkies switch … 3137ms / opens Thunar in list view
 ✓ … seeds the LibreOffice profile … 6511ms
 ✓ … wears the WhiteSur light look with a dock and a menu-bar panel 1188ms
 ✓ … ships WhiteSur without its Apple logos 207ms
 ✓ … saves a 2x screenshot of the themed desktop for the executor to look at 6952ms
 ✓ … switches to 1x with LOCALDOT_SCALE=1 12137ms
      Tests  16 passed (16)
```

### Repo checks on the committed tree

- `pnpm format`: "No fixes applied".
- `pnpm lint`: "Checked 59 files … No fixes applied."
- `pnpm typecheck`: all projects Done.
- `pnpm hygiene`: exit 0. It scans tracked and untracked files.
- `pnpm test`: 16 files, 145 tests passed.

### Step 1 and Step 3 checks

- **The pins.** `git ls-remote` printed `99247ecd219bdc1c7409baff062b4aafcf1102a7` (GTK) and
  `73d8040da51a9ed74e47c7366e7e9ff437601a5c` (icons). Both are lightweight tags, with no `^{}`
  line.
- **The licenses.** The COPYING headers matched: "Copyright (c) 2021 WhiteSur Developers" + MIT,
  and "GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007".
- **The installed trees.** `/usr/share/themes` has `WhiteSur-Light`, `-hdpi` and `-xhdpi`.
  `/usr/share/icons` has `WhiteSur` (63 MB), `WhiteSur-dark` (32 MB) and `WhiteSur-light` (7 MB).
- **The image** grew from 7.21 GB to 7.33 GB: the icon layer is 106 MB and the GTK layer 3.6 MB.

## Screenshots

`/Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon/src/cells/testing/out/look-2x.png`
(2560×1600) and `look-1x.png` (1280×800). Both are gitignored.

**2x (final):**
- **Menu bar:** a light, opaque `#f1f1f1` bar, 54 px. At the left, 12 logical px in, the dark
  app-grid glyph opens the applications menu. At the right, the dark symbolic volume icon and
  "Thu 01 Oct  14:22" sit 8 logical px from the edge. Under the bar runs a thin grey line, the
  panel's border.
- **Window decorations:** a Thunar window in WhiteSur's light xhdpi chrome. Red, yellow and green
  circular buttons sit on the left of the title bar, the bold grey title "config - Thunar" is
  centred, and the top corners are rounded. The menu bar row and toolbar are white, and the list
  view shows WhiteSur's line icons.
- **Dock:** centred at the bottom, a translucent, rounded, light dock over the wallpaper. It holds
  nine crisp 96-device-px WhiteSur icons: Files, Chromium, Terminal, VSCodium, Mousepad, Writer,
  Calc, Impress and GIMP. Files carries Plank's blue active highlight and a running dot.
- **Wallpaper:** the base's own dark sunset lake, unchanged.

**1x (final):** the same design at 1280×800: a 27 px bar, WhiteSur's 1x title bar with the buttons
on the left, and the dock with 48 px icons.

**The brief + D1 image, for comparison** (first screenshot, no longer on disk):
- a near-black `#272727` bar;
- a red "missing image" sign at the top left;
- "13:42abc" flush against the right edge;
- an opaque square grey dock holding Chromium, VSCodium, ImageMagick's wizard and a blurred,
  duplicate Thunar item.

## Files changed (`11ddf3e`)

```
 .gitignore                                                 |   3 +-   (testing/out ignored; two redundant dist lines dropped)
 apps/daemon/src/cells/desktop-image.docker.test.ts         | 189 +++-  (theme, look, Apple-logo, screenshot tests; dockWindow; rulings 5b/5d)
 cells/desktop/Dockerfile                                   |  59 +++-  (Plank + thunar.desktop class, GTK solid build, icons, THIRD-PARTY copy, chmod, 5c/5d)
 cells/desktop/THIRD-PARTY.md                               |  25 +
 cells/desktop/root/defaults/localdot/xfwm4.xml.in          |   4 +-   (use_compositing true, button_layout CHM|)
 cells/desktop/root/defaults/localdot/xsettings.xml.in      |   4 +-   (WhiteSur-Light, WhiteSur)
 cells/desktop/root/defaults/startwm.sh                     |  14 +-   (WhiteSur xfwm4 names, bounded xfconfd wait)
 cells/desktop/root/defaults/xfce/xfce4-panel.xml           |  52 +    (menu-bar panel)
 cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop |   6 +
 cells/desktop/root/usr/local/bin/localdot-plank            |  20 +    (100755; look + launchers pinned)
```

## Self-review

- **Complete.**
  - Steps 1–5 are done, along with controller rulings 1–5 and 7–8. Ruling 6 does not apply: no
    test server.
  - `/usr/local/bin/localdot-plank` is on the base stage's chmod line, which keeps all three
    earlier paths.
  - Paths come from `fileURLToPath(import.meta.url)`.
  - `mkdirSync(OUT)` sits in `beforeAll`, so the non-Docker run creates nothing.
- **Ruling 1.** Every probe whose output is read goes through `outputOf`/`outputAs` (exit 0). The
  "nothing found" waits poll a status: xdotool search exits 1. The `pgrep plank` check is
  status-only.
- **Tests with teeth.** Every new assertion failed for its own reason in RED-1, Audit A or Audit
  B, except the no-actions and menu-icon probes. Those were added after the audits: the menu-icon
  case was shown by hand, and neither failed in a recorded run until fix round 1's panel mutation.
  *(Corrected in fix round 1.)* The panel and Plank struts are deliberate geometry contracts.
- **Quality and YAGNI.**
  - Each change beyond the brief is tied to a screenshot defect, the Apple rule or a measured fact.
  - Comments only state non-obvious reasons:
    - the solid build;
    - the Thunar window class;
    - the Apple logos;
    - why the window isn't killed;
    - the bounded wait;
    - why Plank's window height isn't pinned.
- **Pristine output.** No log noise in any run, and the audit copy was deleted.
- **Docker hygiene, final.**

  ```
  $ docker ps -a --filter name=localdot-test
  CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
  $ docker network ls --filter name=localdot-test
  NETWORK ID   NAME      DRIVER    SCOPE
  $ docker volume ls --filter dangling=true      -> 23, the same names as the pre-task snapshot (diff empty)
  localdot-test volumes: 0; localdot-test images: 0; dangling images: 0
  localdot/desktop:dev = 9d03f9a51d5a (built from 11ddf3e); localdot/gate:dev, localdot/probe:test untouched
  ```

  - Every container, volume and tag I made was `localdot-test-*`: `-3b-manual`, `-3b-probe`,
    `-3b-home`, and `-desktop-{task3,brief,final}` for the RED runs. All were removed.
  - There were no bind mounts. Files went in and out with `docker cp`, or through stdin.
  - Nothing was pruned and nothing else was touched.

## Concerns

1. **Rule on D1–D10.**
   - D2 (the solid build under the Light name) and D5 (no actions plugin) change what the brief
     names.
   - D6 adds behaviour: pinned dock items, plus a one-line `thunar.desktop` edit.
   - Each is easy to back out.
2. **The compositor's cost** is +3.4 points under continuous window drags, with no cost at idle.
   Record it in Task 15's measurement note when that file exists.
3. **Stream frames under the compositor have not been counted with a real client.** Root DAMAGE
   events still arrive, but Task 15 (or Task 4's relay work) should confirm Selkies frames flow
   while windows move.
4. **For Part 3's mapping.**
   - The panel is 27 px at 1x, not 26.
   - Plank's X window is the 2560×324 / 1280×162 bottom slab, input-shaped to the 1132×132 dock.
     Read the strut (132/66), never the dock window's geometry.
5. **Icon variant.** The icon theme stays `WhiteSur`. Its panel status icons are `#f2f2f2`, made
   for dark bars; `WhiteSur-light` is the variant for light bars. Today's panel icons are symbolic
   and render dark. If an app's legacy tray icon ever shows white on the light bar, the fix is that
   one word in `xsettings.xml.in`.
6. **Wallpaper.** It is still the base's dark one; the brief names none. If P2-R12 also wants a
   light wallpaper, that is a separate decision.
7. **Dock resets.** `localdot-plank` resets the dock's items on every start. An agent's changes to
   the dock don't survive a restart, consistent with "the look is localDot's".

## Fix report: the wallpaper (controller ruling after review round 0)

**Status: DONE.** Commit: `3c9cde2 fix(desktop): light dune wallpaper and no dock shadow band`. It
is a new commit on `11ddf3e`, with an empty body and no attribution line: 5 files, 75 insertions, 3
deletions.

### The choice

I looked at all 17 images in `vinceliuice/WhiteSur-wallpapers` (MIT, "Copyright (c) 2022 Vince"):
the 4k sets plus the Nord set.

| Images | Verdict |
|---|---|
| Monterey (all four), Monterey-light | purple, magenta or violet led |
| Sonoma | saturated green/red/violet, garish |
| WhiteSur / Big Sur light, morning, default | pink-red-magenta, with a violet corner |
| WhiteSur-nord-dark, WhiteSur-nord-light | violet or lilac bands |
| Ventura-light | loud orange |
| Ventura-dark | dramatic orange on black |
| WhiteSur-dark, Monterey-nord | calm greys, but mostly dark; a near-black bottom would merge into the Theatre stage |

**Chosen: `Wallpaper-nord/Mojave-nord-light.png`** (5120×2880, 152 KB). It is a flat-colour
dune: a light cool grey-blue sky over sunlit tan and shadowed brown sand. Its colour histogram:

| Colour | Share | Hue / saturation / lightness |
|---|---|---|
| `#563526` dark brown | 40 % | 19° / 39 / 24 |
| `#A4ADBD` sky | 39 % | 218° / 16 / 69 |
| `#845336` brown | 13 % | |
| `#A87044` + `#A36A43` tan | 6 % | |
| `#554851` horizon hills | 1.6 % | 318° but 8 % saturation, so effectively neutral grey |

- **No purple or violet.** On the final 2x screenshot, pixels with hue 255–330° and saturation of at
  least 20 % are 0.000 % of the screen.
- **Calm and muted.** The browns run at 39–42 % saturation, so the cool sky does not clash with them.
  The Theatre's xenon `#3FB5DE` will stand out against them without fighting them.
- **Pinned.** Tag `2023-06-11`, commit `4fe5ae7a01f38f8ff9a25c343e0a49234c1012c9`, a lightweight
  tag. The file is byte-identical at HEAD `5c1d7ca`, and so is the LICENSE.
- **One judgment call.** Like the WhiteSur theme itself, this is a macOS-*style* image: an MIT
  vector redraw by WhiteSur of the Mojave dune subject, not Apple's file. If the no-Apple-artwork
  rule is meant to cover style homages too, the fallback is a neutral image of our own or a
  CC0/MIT one.

### What changed

- **`Dockerfile`.** A new layer after the icon theme downloads the PNG and the LICENSE from
  `raw.githubusercontent.com/vinceliuice/WhiteSur-wallpapers/<commit>/…`. Both go through
  `sha256sum -c`:
  - `WALLPAPER_SHA256=4a5867e8…5833`;
  - `WALLPAPER_LICENSE_SHA256=5a9518c6…b3c6`.

  They land at `/usr/share/backgrounds/localdot/mojave-nord-light.png` and
  `/usr/share/doc/localdot-themes/WhiteSur-wallpapers.LICENSE`. The build log prints `OK` for both.
- **`root/defaults/xfce/xfce4-desktop.xml` (new).** `startwm.sh` copies it into every new home.
  - The property path is `/backdrop/screen0/monitorscreen/workspace0/last-image`, with
    `image-style` 5 ("zoomed", which fills 16:10 from the 16:9 image).
  - xfdesktop keys backdrops by the X output's name, and Xvfb's only connected output is `screen`
    at both scales (from `xrandr`).
  - It also sets `last-settings-migration-version` 1, the marker xfdesktop writes itself, so
    xfdesktop doesn't migrate these settings.
- **Before.** The base sets no backdrop at all: the channel held only the migration marker. So
  xfdesktop drew its compiled-in Xubuntu default.
- **`xfwm4.xml.in`: `show_dock_shadow` false.** This is a new finding from the flat wallpaper.
  - With the compositor on, xfwm4 drew a shadow along the top of Plank's 2560×324 transparent
    window. That is a faint band across the whole screen 324 px above the bottom, darkening from
    `(86,53,38)` to `(77,48,34)` over y=1262–1275 and ending exactly at y=1276.
  - The busy sunset had hidden it.
  - The same setting also drew a soft shadow under the menu bar. The bar now ends on its own
    1 px `#A9A9A9` hairline.
- **`THIRD-PARTY.md`.** A new row for the image, its tag, commit and sha256, MIT, and both paths.
  The copy of the file inside the image is updated with it.

### The wallpaper survives the 1x↔2x switch

`xfce4-desktop.xml` is written only into a new home. The 1x test runs on the 2x container's home
volume, and xfdesktop resolves the same `monitorscreen` key there, so the wallpaper carries over.
That is asserted below.

### The probe (exit statuses checked)

- **`wallpaper(name)`.** It reads the X output's name from `xrandr` (`outputAs`: exit 0), then reads
  `last-image` for that output with `xfconf-query` (exit 0), then runs `test -f` on the path
  (`outputOf`: exit 0). The returned path must equal
  `/usr/share/backgrounds/localdot/mojave-nord-light.png`.
- **"Is the one xfdesktop uses."** `screenPixel` (`import -window root -crop 1x1+x+y`, exit 0) reads
  the drawn desktop. The image's flat colours must appear where its sky and dune are:
  - 2x: `(2400,200)` = `srgb(164,173,189)` and `(2000,1200)` = `srgb(86,53,38)`;
  - 1x: `(1200,100)` and `(1000,600)`, the same two colours.
- **The dock-shadow band.** At 2x, the pixel 6 px above Plank's window top must still be the dune
  colour.
- **Where.** A new test, "draws WhiteSur's light dune wallpaper from a new home's xfdesktop
  settings", runs at 2x. The 1x test asserts the same probe after the switch on the same home. The
  look test's license list gains `WhiteSur-wallpapers.LICENSE`. The suite is now **17 tests**.

### RED

- **The committed image (`9d03f9a5`, commit `11ddf3e`) before the change: 3 failed | 14 passed (17).**
  - The license is missing (`ls`).
  - `Property "/backdrop/screen0/monitorscreen/workspace0/last-image" does not exist on channel
    "xfce4-desktop"`, at 2x and at 1x.
- **Soft audit against the same commit rebuilt from `git archive 11ddf3e`.** Every new assertion
  fails:
  - the license `ls`;
  - the xfconf property, `test -f` exit 1, and the path, each at 2x and 1x;
  - the drawn sky is `srgb(49,42,83)` and the dune `srgb(79,41,70)` at both scales: the old
    sunset's violet and purple-magenta;
  - the dock-band pixel is `srgb(65,33,67)`.
- **Mutation: the final image with only `show_dock_shadow` true.** It fails exactly at the band
  probe: `expected 'srgb(82,50,36)' to be 'srgb(86,53,38)'`. The template was restored and the
  mutant image removed.

### GREEN

17/17 three times, each run about 37–40 s with 0 stderr, warning or unhandled-error lines:
- once on `af385bc3`, from the working tree;
- twice on `12047939`, rebuilt from commit `3c9cde2` with all 13 build steps `CACHED`.

The other checks:
- `pnpm format`: "No fixes applied".
- `pnpm lint`: "Checked 59 files … No fixes applied."
- `pnpm typecheck`: all projects Done.
- `pnpm hygiene`: exit 0.
- `pnpm test`: 16 files, 145 tests passed.

### Screenshots

Same path: `apps/daemon/src/cells/testing/out/look-2x.png` (2560×1600) and `look-1x.png`
(1280×800). Colours sampled from the 2x screenshot:
- **Menu bar:** light grey `#F1F1F1`, dark text and glyphs, ending on a 1 px `#A9A9A9` hairline.
- **Desktop:** the upper right is a flat, light cool grey-blue sky (`#A4ADBD`). The rest is the dune:
  a sunlit tan face (`#A87044`) and mid brown (`#845336`) curving across the left, and a large
  dark brown shadow side (`#563526`). Low, desaturated grey hills (`#554851`) sit at the right
  horizon.
- **Thunar window:** WhiteSur's white chrome with red/yellow/green buttons on the left.
- **Dock:** centred at the bottom. Its translucent light fill reads as a warm grey-taupe
  (`#9E918B`) over the brown, and it holds the nine colourful app icons. No shadow band runs
  above it.
- **Purple/violet:** 0.000 % of pixels.
- **1x:** the same composition at 1280×800 on the same home.
- **The old sunset, for comparison:** violet and magenta skies, with drawn pixels such as
  `srgb(49,42,83)` and `srgb(79,41,70)`.

### Docker hygiene after the round

```
$ docker ps -a --filter name=localdot-test
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker network ls --filter name=localdot-test
NETWORK ID   NAME      DRIVER    SCOPE
$ docker volume ls --filter dangling=true      -> 23, the same names as the pre-task snapshot (diff empty)
localdot-test volumes: 0; localdot-test images: 0; dangling images: 0
localdot/desktop:dev = 12047939fa07 (built from 3c9cde2); localdot/gate:dev, localdot/probe:test untouched
```

- The dock-shadow mutant (`cb27f01a41b5`) was left dangling when the tag moved. I removed it by ID
  after confirming it was mine: built at 14:38:46Z with `show_dock_shadow` true.
- Every container, volume and tag I made was `localdot-test-*`: `-3b-manual`, `-3b-home`,
  `-3b-probe` and `-desktop-prev`. All were removed.
- There were no bind mounts: files went in and out with `docker cp`. Nothing was pruned.

### Concerns

1. Under the no-Apple-artwork rule, the wallpaper is a macOS-style homage (WhiteSur's MIT redraw of
   the Mojave dune), not Apple's file. Veto it if the rule should also exclude style homages.
2. `show_dock_shadow` false also removes the menu bar's soft shadow. It is intended (the bar keeps
   its hairline), and it goes slightly beyond the wallpaper ruling.
3. The wallpaper key depends on Xvfb's output name, `screen`. If a base image ever switches to an
   X server whose output is named otherwise, the probe fails: it reads the live output's key. The
   default file would then need that key.

## Fix report: task review round 1 (five Minors fixed, one report correction)

**Status: DONE.** Commit: `b7ee200 fix(desktop): WhiteSur-light icons, per-file xfconf defaults and
atomic template writes`. It is a new commit on `3c9cde2`, with an empty body and no attribution
line: 5 files, 45 insertions, 16 deletions.

### 1. The icon theme is now `WhiteSur-light`

- **Change.** `xsettings.xml.in` sets `IconThemeName` to `WhiteSur-light`.
- **No new build step.** The image already ships that variant, built by upstream's own
  `install.sh -t default`. It recolours `status/{16,22,24,32}` from `#f2f2f2` to `#363636`, links
  `status/symbolic` and every other folder back to `../WhiteSur/…`, and has its own icon cache.
- **The probe** reads the live `IconThemeName` and `cat`s that theme's panel-size, non-symbolic
  `status/16/audio-volume-high.svg` (exit 0). It must contain `color:#363636` and must not contain
  `#f2f2f2`. The file in `WhiteSur` has `color:#f2f2f2` + `#4285f4`; the one in `WhiteSur-light`
  has `color:#363636` + `#4285f4`.
- **The menu-icon probe** now searches the active theme with `find -L`, which follows
  `WhiteSur-light`'s symlinked folders. It exits 0 and finds both `actions/` and `actions@2x/`.
  The file list checks both themes' `index.theme`.
- **Look unchanged.** The bar's volume icon is symbolic, and Thunar's, the menu's and Plank's icons
  come through the links. Every sampled 2x pixel is identical to the previous round.

### 2. The xfconf defaults are filled per file on every start

- **Change.** `startwm.sh` now runs `mkdir -p "$conf"` then
  `cp --update=none /defaults/xfce/*.xml "$conf"/` on every start, before the kill loop.
- **Why not `cp -n`.** I used `--update=none` rather than the ruling's literal `cp -n`. The image's
  GNU coreutils 9.7 prints "cp: warning: behavior of -n is non-portable and may change in future;
  use --update=none instead" on every `-n`, though it exits 0. `--update=none` has the same
  semantics and no warning; both forms were checked in the image.
- **What stays first-run only:**
  - the LibreOffice profile seed, which is gated on its own `registrymodifications.xcu` and must
    never overwrite a profile LibreOffice has written;
  - every xfconf channel file a home already has: thunar, panel, desktop, keyboard shortcuts and
    displays are kept as they are.
- **Rewritten on every start**, as before: only `xsettings.xml` and `xfwm4.xml`.
- **Test.** The 1x test now deletes `xfce4-desktop.xml` from the shared home (a `--rm` container,
  `localdot-test-desktop-home-edit`, also in `beforeAll`/`afterAll`'s `removeAll`) before C1
  starts. The existing 1x wallpaper probes then prove the missing channel is filled in.
  - **RED** on the `3c9cde2` image (soft audit): the backdrop property is missing, `test -f`
    exits 1, and the drawn pixels are the Xubuntu sunset's `srgb(48,42,83)` / `srgb(79,41,70)`.
  - **GREEN** on this commit.
- **By hand, on the final image:**
  - a home whose xfconf folder already existed but was empty (made beforehand, as xfconfd can) got
    every default: the panel's `plugin-2 applicationsmenu` with `view-app-grid-symbolic`, the
    wallpaper, and Thunar's `ThunarDetailsView`;
  - after `docker restart`, an in-session Thunar change (`ThunarIconView`) was kept, while an
    in-session `IconThemeName=WhiteSur-dark` was reset to `WhiteSur-light` by the template.

### 3. The templates are written atomically

Each of `xsettings.xml` and `xfwm4.xml` is written by `sed` to `$conf/<name>.xml.new`, then
`mv -f`'d into place (the same folder, so the rename is atomic). An xfconfd re-activated between the
kill and the writes sees either the old file or the new one, never a truncated one.
- No `.new` files are left after a start or a restart (checked by hand, twice).
- There is no deterministic RED for a race this narrow; the GREEN runs exercise the new path on
  every start.
- An xfconfd re-activated *before* the writes still serves the old values: that is Task 5's
  existing pointer, unchanged.

### 4. The Thunar edit cannot silently do nothing

The Plank RUN now runs `sed … && grep -qx 'StartupWMClass=Thunar-real'
/usr/share/applications/thunar.desktop && apt-get …`.
- **RED by hand:** on a copy of `thunar.desktop` whose header the `sed` cannot match
  (`[Desktop Entry] ` with a trailing space), `sed && grep` exits 1, which fails the RUN.
- **GREEN:** the build passed. The image's file has the line (`2:StartupWMClass=Thunar-real`), and
  BAMF's index reads `thunar.desktop thunar %U Thunar-real`.

### 5. Plank's row

- `THIRD-PARTY.md` now says "Ubuntu package (unpinned, like the rest of apt)".
- The license `ls` probe includes `/usr/share/doc/plank/copyright`.
  - **RED:** `ls` exits 2 on the pinned base image, which has no Plank.
  - **GREEN:** it exits 0 on the final image, where `dpkg-query` reports plank `0.11.89-6ubuntu1`
    today.

### 6. Report corrections (mislabelled evidence)

- **Relabelled.** `e348d00e` is now "brief + D1" everywhere above: the status line, D4, the CPU
  table, the panel-height note, the GREEN note, Audit B and the screenshot comparison. It already
  had D1's Apple-logo removal and D10's layout-only changes.
- **Claims corrected.** The audits ran before the no-actions and menu-icon probes existed. So
  "every new assertion failed" now excludes them: the menu-icon case was shown by hand, and
  neither appeared in a recorded run.
- **Now recorded (cheaply).** A mutant of the final image with only the brief's own
  `xfce4-panel.xml` (verbatim, with the `distributor-logo` button and the `actions` plugin) ran a
  soft copy of the look test. **Exactly those two probes failed:**

  ```
  expected '/configver …' not to contain 'actions'                    (D5 no-actions probe)
  expected '' not to be ''                                            (D4 menu-icon probe: no distributor-logo.svg in WhiteSur-light)
  Tests  1 failed | 16 skipped (17)
  ```

  Our panel file was restored (git showed it unchanged) and the image rebuilt. The mutant image
  (`d0091d16`) was gone once the tag moved; none was left dangling.

### RED / GREEN summary for the round

- **RED:** the soft audit of the new test against the `3c9cde2` image (`12047939`) gave **2
  failed | 10 passed**:
  - `expected 'WhiteSur' to be 'WhiteSur-light'`;
  - the status icon lacks `color:#363636` and contains `#f2f2f2`;
  - the 1x wallpaper probes as in item 2.

  The panel mutation is under item 6; the Thunar guard and the Plank license are under items 4
  and 5.
- **GREEN:** 17/17 three times, each about 37 s with 0 stderr, warning or unhandled-error lines:
  - once on `b815eb13`, from the working tree;
  - twice on `c1522d53`, rebuilt from commit `b7ee200` with all 13 steps `CACHED`.
- **Repo checks:**
  - `pnpm format`: "No fixes applied".
  - `pnpm lint`: "Checked 59 files … No fixes applied."
  - `pnpm typecheck`: all projects Done.
  - `pnpm hygiene`: exit 0.
  - `pnpm test`: 16 files, 145 tests passed.

### 2x screenshot

The same path, re-taken: the look is unchanged. All six sampled pixels equal the previous round's:
- the bar `#F1F1F1`;
- the sky `#A4ADBD`;
- the dune `#563526`, also in the band above the dock (no shadow);
- the dock fill `#9E918B`;
- the window white.

By eye, the bar, Thunar's window, the dune and the nine-icon dock are as before.

### Docker hygiene after the round

```
$ docker ps -a --filter name=localdot-test
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
$ docker network ls --filter name=localdot-test
NETWORK ID   NAME      DRIVER    SCOPE
$ docker volume ls --filter dangling=true      -> 23, the same names as the pre-task snapshot (diff empty)
localdot-test volumes: 0; localdot-test images: 0; dangling images: 0
localdot/desktop:dev = c1522d532570 (built from b7ee200); localdot/gate:dev, localdot/probe:test untouched
```

All the containers and volumes I made in this round were `localdot-test-*` (`-3b-manual`,
`-3b-home`, `-3b-probe`, `-desktop-home-edit`) and were removed. There were no bind mounts and no
prunes.
