# S2 findings: Cua Driver perception and input

2026-09-30 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop engine 29.2.0 · `localdot-spike-s2` (`sha256:13390a704cdd…`)
on `lscr.io/linuxserver/webtop:ubuntu-xfce@sha256:73f966bd414c…`: Ubuntu 26.04.1, XFCE 4.20, AT-SPI 2.60.4 ·
Cua Driver 0.30.4 (PyPI wheel, bundled `aarch64-linux` binary) · Chromium 154.0.8037.57, LibreOffice 26.2.5.2 (gtk3),
Thunar 4.20.7, xfce4-terminal 1.1.5, Mousepad 0.7.0 · Node 25.6.0

**Result: GO-WITH-CHANGES. Use Cua Driver, not the xdotool + pyatspi fallback, as the perception backend.**

- **It works on this image.** The wheel's README lists Linux x86_64 only, but its `aarch64-linux` binary runs here.
  It returns trees with roles, names and screen frames for all six apps; none returned `none`. It injects real XTest
  input: in Step 6, `hello` landed in A1. Its cursor overlay stays off only with `mcp --no-overlay`.
- **The fallback would be no more accurate for native apps.** Raw AT-SPI extents read through libatspi (which is
  what pyatspi wraps; `atspi-extents.py`) match the driver's frames exactly for Thunar, the terminal, Calc and
  Chromium's browser chrome, with GTK window scaling off and on. That includes LibreOffice's own menu-bar-height
  error. The driver is worse only on Chromium web content, where it adds an offset that raw AT-SPI does not have.
  Web content should come from CDP anyway: a walk takes 2.1–2.3 s for example.com and 12 s for a full Wikipedia
  article.
- **Changes needed:**
  1. **Launch.** Run the bundled binary directly, not the pip entry point:
     `/opt/venv/lib/python3.14/site-packages/cua_driver/bin/cua-driver mcp --no-overlay`. Run it as `abc` with
     `DISPLAY=:1`, the xfce4-session's `DBUS_SESSION_BUS_ADDRESS`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and
     `CUA_DRIVER_RS_UPDATE_CHECK=0`. Why each is needed is under Setup.
  2. **`desktopd` maps every frame into desktop device pixels** with one transform per toolkit (see "Canonical
     space and one transform per toolkit"). It never uses the driver's window-local `screenshot_frame`, which is
     wrong whenever a toolkit reports logical px. It also handles two gaps in the trees:
     - Calc cells are not in the tree at all.
     - Calc and Writer windows with the same geometry return each other's elements.
  3. **Image.**
     - Exactly one D-Bus session bus. Today a second, autolaunched bus exists, and it can take over the
       accessibility bus's socket.
     - Thunar opens in List View.
     - Chromium runs maximized.
- **Open question for Task 5 (S6): should pointer and keys bypass the driver?**
  - The driver injects only in foreground mode here. A foreground click or keystroke call returns after 843–893 ms
    (medians) and gives no injection timestamp, but `input()` must return one.
  - This spike timed pointer motion only: the X pointer reached the target about 30 ms into the call. The
    ButtonPress and the key events were never timed.
  - The rest of the call may be the documented foreground round trip (activate, confirm focus, inject, restore). Our
    own XTest path might need that too, and it was not timed.
  - S6 should time both paths with XI2 raw events before anything moves off the driver.

## Trees and frame accuracy per app

Offsets are in device px, measured after each toolkit's transform (see "Canonical space and one transform per
toolkit"). "GTK ×1" and "GTK ×2" are the 2× desktop with `Gdk/WindowScalingFactor` 1 and 2.

| App | Tree | Worst offset 1× | 2×, GTK ×1 | 2×, GTK ×2 | Notes |
|---|---|---|---|---|---|
| Chromium, browser chrome | good | ≤ 1 px | ≤ 1 px | ≤ 1 px | frames are Chromium DIPs (×2 at 2×); tabs, toolbar buttons, address bar, window buttons; raw AT-SPI returns the same values |
| Chromium, web content | partial | +4, 0 restored; 0, 0 maximized | +18, +23 restored; 0, −1 maximized | +18, +37 restored; 0, 0 maximized | the driver adds the offset; raw AT-SPI is exact device px in all six cases and sizes are exact; text comes as one `static` row per character; headings are not rows |
| LibreOffice Calc | partial | 27 px y on VCL widgets, 0 on GTK widgets | 45 px y | 54 px y (27 logical px) | the shift equals the native menu bar height; raw AT-SPI is identical; cells are not walked (`truncation_reason: huge_container`), so A1 has no frame; a duplicate menu bar with different frames is also listed |
| LibreOffice Writer | partial | 27 px y (toolbars, paragraph) | not run | not run | its tree also lists Calc's document (Sheet1 table and tab, Calc-only toolbar buttons): both windows were 1280×750+0+50 |
| Thunar | good in List View, partial in the default icon view | 0 | 0 | 0 | the icon view is one `directory pane` with no items; after Ctrl+2 each file is a row of cells (name, size, type, date) with exact frames |
| xfce4-terminal | good | 0 | 0 | 0 | menus and the VTE widget; the terminal text is not in the tree |
| Mousepad | good | 0 | not run | not run | menus and the text view |

- **How to read the offsets.** "0" means the overlay's 1 px stroke sits on the control's edges in 1–6× crops. The
  Chromium web numbers are exact pixel boxes from `markers.mjs`.
- **Chromium web content.** A marker page has solid-colour controls at known CSS positions. Driver frame minus
  pixel box, for all three markers:

  | | Restored | Maximized |
  |---|---|---|
  | 1× | (+4, 0) | (0, 0) |
  | 2×, GTK ×1 | (+18, +23) | (0, −1) |
  | 2×, GTK ×2 | (+18, +37) | (0, 0) |

  Raw AT-SPI gave the pixel boxes exactly for `marker red`:

  | | Raw AT-SPI | Driver |
  |---|---|---|
  | 1×, restored | (54,164) | (58,164) |
  | 2×, GTK ×1, restored | (108,300) | (126,323) |
  | 2×, GTK ×2, restored | (108,328) | (126,365) |
- **LibreOffice.** The error is systematic. The toolbar buttons and their panels, the sheet table and the sheet
  tabs are reported exactly one menu-bar height too high. In frame units that is 27 px at 1×, 45 px at 2× with
  GTK ×1 (LibreOffice then scales its own UI to the 192 dpi), and 27 logical px (54 device px) at 2× with GTK ×2.
  Other widgets are correct: the Name Box and font-name text fields (children of shifted panels), the Add-sheet
  button, the scrollbars and the sidebar. A consumer that trusts these frames misses: A1's centre derived from the
  table frame (33,187) falls in the column header.
- **Web trees are slow.** Chromium's example.com tree ran out of the default 1000 ms budget (539 nodes visited).
  Wikipedia's "Accessibility" article gave 202 elements at 1000 ms and 977 at 5000 ms (both truncated). The
  complete tree has 2251 elements and took 12.1 s.

## Latency

Each value is the median of 7 calls in one MCP session, with `timeout_ms: 5000`. The 2× numbers are from the GTK ×1
desktop.

| `get_window_state` | Tree only | Tree + window shot | Window shot only |
|---|---|---|---|
| Chromium, example.com, 1× restored / 2× maximized | 2283 / 2109 ms | 2326 / 2342 ms | 30 / 151 ms |
| Calc 1× (249 elements, Writer's included) / 2× (Calc alone, 129) | 1135 / 552 ms | 1140 / 706 ms | 37 / 170 ms |
| Writer 1× (238 elements) | 1181 ms | 1165 ms | 38 ms |
| Thunar 1× / 2× (75 elements) | 254 / 223 ms | 254 / 234 ms | 27 / 30 ms |
| xfce4-terminal 1× / 2× (20 elements) | 87 / 83 ms | 93 / 125 ms | 29 / 61 ms |
| Mousepad 1× (20 elements) | 108 ms | 117 ms | 24 ms |

- **Full-screen screenshot** (`get_desktop_state`): 57 ms at 1× (1280×800) and 184 ms at 2× (2560×1600). At 2× with
  `max_image_dimension: 1280` it took 289 ms. The PNG equals `import -window root` byte for byte: 0 of 3,072,000
  bytes differ at 1×.
- **Hit test.** There is no stand-alone hit-test tool. A background pixel click hit-tests internally, and
  `desktopd`'s `hitTest` would be a tree-only `get_window_state` plus a frame search (the tree-only column).
- **Click and type, 1×, `--no-overlay`:**

  | Call | Median | Notes |
  |---|---|---|
  | Accessibility click by `element_token` (Thunar Home) | 311 ms | `route: accessibility` |
  | Background pixel click on the same button | 316 ms | the driver fired the button's AT-SPI action (`path=x11_atspi`) |
  | Foreground XTest pixel click | 886 ms Thunar, 893 ms Calc | `path=x11_xtest_fg` |
  | Foreground `type_text` of one character (Mousepad) | 843 ms | |

- **When the pointer moves.** This measures pointer motion, not when input lands.
  - Polling `xdotool getmouselocation` about every 13 ms, the X pointer reached the click target 29 and 35 ms after
    a container-clock stamp taken just before each of two foreground clicks.
  - Each call returned 860–868 ms after it started.
  - The ButtonPress and the key events of `type_text` were not timed.
  - The tail may be the foreground focus round trip rather than idle waiting. S6 decides this (see the open
    question in the Result).

## Input and the driver's cursor (Step 6)

- **A1 had to be located on the screenshot.** A1 is not in the tree (see Calc), so its centre was measured on the
  screenshot: screen (73, 222), window-local (73, 172).
- **Background delivery is refused.** A background click on A1 was refused after 1763 ms: `background_unavailable`,
  "No accessible control covers this point and the toolkit drops synthetic pointer events". Background keys are
  refused too: "needs a virtual master keyboard fed by a uinput device … Xvfb/Xtigervnc cannot hot-add input
  devices".
- **Foreground input works.** The foreground click took `path=x11_xtest_fg`. Foreground `type_text "hello"`
  replied "Typed 5 character(s) as real key events (delivery_mode=foreground, focus_after=target)". The screenshot
  shows `hello` in A1 and in the formula bar; later clicks committed it. At 2×, `coordinate_frame: "desktop"`
  (322, 365) selected B2.
- **The cursor overlay is on by default.** It appeared on the first cursor-bearing action: a blue arrow on A1 and
  an `s2` badge below it. The screenshots were taken with `import -window root` during the session, so they show
  the X root as Selkies captures it. The driver's own screenshots always leave the overlay out
  (`agent_overlay_capture: excluded`), so they cannot prove the stream is clean.
- **`set_agent_cursor_enabled` does not keep the cursor off.** Its arguments are `{session, enabled}`, both
  required.
  - Session `s2`: the call replied "disabled" and the next capture had no cursor.
  - Session `s4`: the cursor came back on the very next click and stayed through typing.
  - Session `s3`: disabling before the first action did nothing.
  - `get_agent_cursor_state` kept reporting `enabled: true` after the disable call.
- **`mcp --no-overlay` keeps it off.** In session `s5` no cursor appeared after a click or after typing.
  `get_agent_cursor_state` reported `enabled: false` and `get_session` reported `cursor_visible: false`. Harmless
  `overlay: X11 channel rejected command` warnings go to stderr. The help text lists the flag under `serve`, but on
  Linux `mcp` owns the runtime and honours it. `mcp` also accepts unknown flags silently, which is why the effect
  was checked on screen.

## 2× coordinate space (Ruling 16)

- **Two 2× desktops were measured.** Both used `SELKIES_MANUAL_WIDTH=2560 SELKIES_MANUAL_HEIGHT=1600
  SELKIES_SCALING_DPI=192` with no viewer connected (`xdpyinfo` read 96 dpi; S1, with a viewer, saw 192).
  - **GTK ×1**, as the image starts: `Gdk/WindowScalingFactor` 1, XFCE `Xft/DPI` 96, `xrdb` `Xft.dpi: 192`.
    - GTK apps are not scaled: Thunar's window stays 640×480 device px.
    - LibreOffice scales its own UI from the 192 dpi, giving a 45 px menu bar.
    - Chromium renders at scale 2.
  - **GTK ×2**, S1's proposal for Part 2: `xfconf-query -c xsettings -p /Gdk/WindowScalingFactor -s 2` and
    `-p /Xft/DPI -s 96`. Selkies had set `Xft/DPI` to 192 by then, and the change also reset `xrdb` `Xft.dpi` to
    96. Apps were started after the change.
    - GTK windows double: Thunar 1280×960 device px, the panel 54 px tall.
    - LibreOffice doubles too: its Welcome dialog is 1374×818 for 687×409.
    - Chromium stays at scale 2, in a 2100×1506 window.
- **The driver itself has one space: X11 device pixels.**
  - `get_screen_size` reports 2560×1600 at `scale_factor` 1;
  - `get_desktop_state` returns a 2560×1600 PNG at `frame_scale` 1;
  - `list_windows` bounds are X11 geometry;
  - `coordinate_frame: "desktop"` clicks use it ((322, 365) selected B2).
- **It passes element frames through as each toolkit reports them.** The driver's frames equal raw AT-SPI
  everywhere except Chromium web content. Toolkits differ in units:

  | Toolkit | GTK ×1 | GTK ×2 |
  |---|---|---|
  | GTK apps (Thunar, terminal) | device px: Thunar Home (1057,634) 31×40 | logical px: Thunar's File menu is (0,39) 39×27 for a window at device (1,78) |
  | LibreOffice (gtk3) | device px | logical px: File menu (0,38) 39×27 for a window at device (0,77) |
  | Chromium browser chrome | logical px: root frame 1050×767 at (10,23) for an X window 2100×1534+20+46 | logical px: root frame 1050×753 at (10,37) for 2100×1506+20+74 |
  | Chromium web content (raw AT-SPI) | device px | device px |

  With window scaling on, GTK and LibreOffice frames come back logical. That fits GTK's ATK bridge building extents
  from widget allocations and window origins in application px (the mechanism is inferred, not traced).
- **The driver's derived pixel numbers are wrong whenever a frame is logical.** It computes `screenshot_frame` as
  (frame − window origin) × `frame_scale`, treating frames as device px.
  - Under GTK ×2, Thunar's Home button gets (93, −8) 30×30; its true place in that screenshot is (186.5, 59.9)
    60×60.
  - For Chromium chrome at 2× the root frame gets (−6, −14).
  - Clicks by `element_token` go through the accessibility action and are unaffected.
- **Window screenshots are downscaled at 2×.** `get_window_state` caps its screenshot at 1.15 MP (long edge 1568)
  unless `max_image_dimension: 0` is passed. With GTK ×1, Calc's came back 1377×834 (`frame_scale` 0.538),
  restored Chromium's 1254×916 (0.597), and the terminal's 1357×846 (0.882).
- **Click coordinates follow the frame you pick.** Window-frame click x/y are pixels of that downscaled image:
  (250, 200) became screen (465, 422) and selected C4. With `coordinate_frame: "desktop"`, x/y are device px.

### Canonical space and one transform per toolkit

- **The canonical space is desktop device pixels**, the X root: 2560×1600 at 2×, 1280×800 at 1×. Selkies streams
  it, `get_desktop_state` returns it, and XTest and `coordinate_frame: "desktop"` clicks use it.
- **`desktopd` converts every frame into it with the transform for its toolkit**, then derives the model and
  overlay space once: model = device ÷ S, where S is the desktop scale (2 at 2×, 1 at 1×). The parameters:
  - **g** is `Gdk/WindowScalingFactor`.
  - **c** is Chromium's device scale factor: X11 window width ÷ the width of Chromium's root `frame` element. It
    was 1 at 1× and 2 at 2× with both GTK settings.
  - **m** is LibreOffice's native menu bar height in frame units, the `h` of its `menu` rows. It was 27 with
    `Xft/DPI` 96, and 45 when LibreOffice renders at 192 dpi with g = 1.

| Toolkit | device px = | Measured with |
|---|---|---|
| GTK3 apps (Thunar, xfce4-terminal, Mousepad) | frame × g | Thunar and the terminal at 1× with g=1, 2× with g=1 and 2× with g=2; Mousepad at 1× only. All exact |
| LibreOffice gtk3, GTK-drawn parts (menus, text entries, Add-sheet button, scrollbars, sidebar) | frame × g | Calc in the same three: exact |
| LibreOffice gtk3, VCL-drawn parts (toolbars and their panels, sheet table, sheet tabs, document text) | (frame + (0, m)) × g | Calc in the same three. No attribute marks a VCL part, so this is a per-role workaround at best; treat LibreOffice frames as unreliable |
| Chromium browser chrome (`in_web_content` absent) | frame × c | 1× (c=1); 2× with g=1 and with g=2 (c=2): ≤ 1 px |
| Chromium web content | CDP box (CSS px) × c + the content area's device origin | the driver's frames carry a driver-added offset. Raw AT-SPI web extents are already device px, exact in all six marker cases, if CDP is ever unavailable |

- **In the planned product desktop** (2×, g = 2, `Xft/DPI` 96, c = 2), every native frame the driver returns is
  already in model units (1280×800), and device = frame × 2.
- **Only Chromium web content needs CDP.** The one other departure is LibreOffice's VCL offset, which is
  LibreOffice's.

## Setup that was needed

- **Step 2 runs as root, which cannot read `abc`'s environment.** Root in this container has no
  `CAP_SYS_PTRACE` (`CapEff 00000000a80425fb`). Used `docker exec -u abc ld-s2 sh -c 'tr "\0" "\n" <
  /proc/$(pgrep -u abc -n xfce4-session)/environ | grep DBUS_SESSION_BUS_ADDRESS'`.
- **The pip entry point fails as `abc`.** `/opt/venv/bin/cua-driver` works only as root. As `abc` it fails with
  `PermissionError: [Errno 1] Operation not permitted`, because the wrapper calls `os.chmod` on the root-owned
  binary each time it runs.
- **The driver needs the desktop's session bus.**
  - With a wrong address, a tree degrades to one window row (`degraded_reason: atspi_walk_failed`), and
    `health_report`'s `ax_capability` says "X11 is reachable but AT-SPI (org.a11y.Bus) is not".
  - `AT_SPI_BUS_ADDRESS` is ignored.
  - Apps started with the brief's `docker exec` lines (no bus address) still register; the X root window carries
    the accessibility bus address in `AT_SPI_BUS`, which is probably how they find it.
- **The image starts a second session bus** (`dbus-launch --autolaunch`) besides xfce4-session's.
  - Pointing the driver at it D-Bus-activated a second `at-spi-bus-launcher`.
  - Its daemon took over `/config/.XDG/at-spi/bus_1`.
  - From then on every new driver session logged `could not activate the persistent AT-SPI listener: … Handshake("Server
    GUID mismatch …")`. I recreated the container instead of testing further.
- **Telemetry and update checks.** Per the driver's own notice: "Cua Driver sends content-free product telemetry
  by default". The binary's endpoint is `https://eu.i.posthog.com/capture/`, and it also asks GitHub for updates.
  - `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` or `CUA_TELEMETRY_ENABLED=false` turns telemetry off; `DO_NOT_TRACK=1` does
    not.
  - `cua-driver telemetry disable` makes it persist in `~/.cua-driver`.
  - `CUA_DRIVER_RS_UPDATE_CHECK=0` is the update opt-out according to the binary's strings; not observed on the
    wire.
  - In the first container, `config` and `doctor` ran before telemetry was off. `telemetry status` then read
    `Registration recorded: true`, so one install registration was probably sent. Every later container disabled
    telemetry first (`Installation ID: not created`).
- **LibreOffice's first-run dialogs are modal.** "Welcome to LibreOffice!" and "Tip of the Day" were closed with a
  foreground `press_key Escape`. The Welcome dialog has no Close button in its tree.
- **Thunar started its own process.** `thunar` launched without the session bus address started a separate
  `thunar-real` instead of reusing the session's daemon.

## Tools (62)

```
list_apps, list_windows, get_window_state, verify_state, launch_app, kill_app, bring_to_front, set_window_frame,
invoke_menu, click, double_click, right_click, drag, mouse_button_down, mouse_drag, mouse_button_up,
parallel_mouse_drag, type_text, press_key, hotkey, set_value, scroll, clipboard_read, clipboard_write,
get_screen_size, get_desktop_state, get_cursor_position, move_cursor, set_agent_cursor_enabled,
set_agent_cursor_motion, get_agent_cursor_state, set_agent_cursor_theme, check_permissions, health_report,
get_config, set_config, get_accessibility_tree, zoom, page, get_browser_state, browser_prepare, browser_navigate,
browser_click, browser_type, browser_dialog, browser_set_input_files, browser_download, browser_pointer,
start_recording, stop_recording, get_recording_state, replay_trajectory, install_ffmpeg, start_session,
escalate_session, get_session, list_sessions, get_session_state, end_session, check_for_update, install_extension,
parse_visual_regions
```

Calls used, with their argument names as `out/tools.json` defines them:

- `list_windows {}`: returns `windows[] {window_id, pid, app_name, title, bounds {x,y,width,height}, z_index}`.
- `get_window_state {pid, window_id, timeout_ms, include_screenshot, include_accessibility_tree, session}`.
  - `structuredContent.elements[]` has `element_index`, `element_token`, `role`, `label`, `value`, `frame {x,y,w,h}`
    (screen), `screenshot_frame`, `parent_index`, `depth`, `actions` and `in_web_content`.
  - Beside the elements it returns `window_bounds`, `screenshot_width/height`, `frame_scale`, `truncated`,
    `truncation_reason`, `snapshot_id` and `dialogs`.
  - Element tokens and snapshots live only inside one MCP session.
- `get_desktop_state {max_image_dimension, session}`.
- `click {pid, window_id, x, y | element_token, delivery_mode, coordinate_frame, session}`: `pid` is required even
  with a token.
- `type_text {pid, window_id, text, delivery_mode, session}`.
- `press_key {pid, window_id, key, modifiers, delivery_mode}`.
- `bring_to_front {pid, window_id}`.
- `set_agent_cursor_enabled {session, enabled}`, `get_agent_cursor_state {session}`, `get_session {session}`.
- `get_screen_size {}`, `health_report {}`, `get_config {}`.
- `get_accessibility_tree` lists processes and windows only, not elements (per its description; not called).

## Files and changes from the brief

- `Dockerfile` and `package.json`: as in the brief.
- `probe.mjs`: the brief's, with these changes:
  - it execs the bundled binary and passes the two opt-out variables;
  - `out/` sits next to the script (the brief's cwd-relative `out/` lands in the repo root, outside the git-ignored
    `spikes/**/out/`);
  - `call` takes an optional repeat count and prints every latency and the median;
  - `seq` runs several calls in one session: `{"$label": …}` resolves an element token from the last
    `get_window_state`, and `["$sh", cmd]` runs a shell step;
  - `LD_DRIVER_ARGS` appends driver flags such as `--no-overlay`.
- `overlay.mjs`: the brief's, plus an optional scale argument (default 1) for the 2× check.
- Added:
  - `capture.sh`: bring the window to front, save its tree, take an `import` screenshot, draw the overlay;
  - `marker.html` and `markers.mjs`: exact web-content offsets;
  - `atspi-extents.py`: raw AT-SPI extents, the fallback's view.

## Method

- **Containers.** 1× used the brief's `docker run`. I created it three times: once for the main run, again after the
  bus takeover, and a third time only for the 1× raw-AT-SPI check. 2× used the same command with
  `-e SELKIES_MANUAL_WIDTH=2560 -e SELKIES_MANUAL_HEIGHT=1600 -e SELKIES_SCALING_DPI=192`. Apps were launched with the
  brief's `docker exec -d -u abc -e DISPLAY=:1 …` lines, plus `libreoffice --writer` and `mousepad`.
- **GTK ×2 desktop.** A fresh 2× container. Before starting any app:
  `docker exec -u abc -e DISPLAY=:1 -e DBUS_SESSION_BUS_ADDRESS=… ld-s2 sh -c 'xfconf-query -c xsettings -p
  /Gdk/WindowScalingFactor -s 2; xfconf-query -c xsettings -p /Xft/DPI -s 96'`. Then Calc, Thunar and the terminal
  were started with the brief's lines, and Chromium with the marker page. Each app went through `./capture.sh`, and
  its frames were drawn ×2 with `node overlay.mjs out/<label>-s.png out/<label>-state.json out/<label>-overlay-x2.png
  2`.
- **Trees and overlays.** `./capture.sh <label> <pid> <window_id>` (the `SCALE` env var sets the overlay scale)
  writes `out/<label>-state.json`, `-s.png` and `-overlay.png`. I looked at each overlay whole and in 2–6×
  nearest-neighbour crops.
- **Web offsets.** `marker.html` was copied into the container with `docker exec -i … sh -c 'cat >
  /config/s2-marker.html'` and opened in the running Chromium. Then `./capture.sh marker-…` and `node markers.mjs
  out/<label>-s.png out/<label>-state.json [scale]`, which finds each solid-colour box and prints frame minus pixels.
- **Raw AT-SPI.** `docker cp atspi-extents.py ld-s2:/tmp/`, then `docker exec -u abc -e DISPLAY=:1 -e
  DBUS_SESSION_BUS_ADDRESS=… ld-s2 /usr/bin/python3 /tmp/atspi-extents.py <app> <names…>`.
- **Latency.**
  - Tree calls: after `bring_to_front`, `node probe.mjs call get_window_state
    '{"pid":…,"window_id":…,"timeout_ms":5000,"include_screenshot":false}' 7`, then the same with `true`, then with
    `"include_accessibility_tree":false`.
  - Clicks and typing: a `seq` of seven identical steps after one `get_window_state`.
  - Times are MCP round trips from the host over `docker exec` stdio; a trivial `get_config` takes 3 ms.
- **Injection time.** A loop in the container logged `date +%s.%N` with `xdotool getmouselocation` about every
  13 ms. `$sh` steps stamped the container clock before and after each foreground click.
- **Cursor.** `seq` runs with `$sh` steps that capture `import -window root` while the session, and so its overlay,
  is alive.

## Not covered

- VSCodium (in the spec's S2 list, not in the brief's image).
- Writer and Mousepad at 2×.
- The 2× desktop with a viewer connected.
- A LibreOffice build with the Qt VCL plugin, which might report correct frames.
- Background input with uinput.

## Raw

Chromium, 1×, example.com (`tree_markdown`, 828 lines, 785 of them `static` character rows):
```
- [0] frame "Example Domain - Chromium" [actions=[doDefault,showContextMenu]]
      - [3] button "Minimize" [actions=[press,showContextMenu]]
      - [4] button "Maximize" [actions=[press,showContextMenu]]
      - [5] button "Close" [actions=[press,showContextMenu]]
          - [8] tool bar "￼￼￼￼￼￼￼￼￼￼￼￼￼￼￼" [actions=[doDefault,showContextMenu]]
            - button = "Back" (disabled)
            - [9] button "Reload" (description "Reload this page") [actions=[press,showContextMenu]]
              - [12] entry "Address and search bar" [actions=[activate,showContextMenu]]
            - [20] document web "Example Domain" [actions=[doDefault,showContextMenu]]
              - [21] paragraph "This domain is for use in documentation examples without needing permission. T…" [actions=…]
                - static = "T"
              - [27] link "Learn more" [actions=[jump,showContextMenu]]
```
Calc, 1× (`structuredContent.elements`, window at 0,50; `truncation_reason=huge_container`, 129 elements):
```
[1]   menu "File"          frame={"h":27,"w":39,"x":0,"y":50}     native menu bar, correct
[14]  menu "File"          frame={"h":22,"w":36,"x":0,"y":50}     duplicate menu bar
[62]  button "New"         frame={"h":36,"w":45,"x":4,"y":52}     on screen y 79-115: 27 px high
[94]  panel "Font Name"    frame={"h":30,"w":207,"x":4,"y":93}    27 px high
[95]  text "DejaVu Sans"   frame={"h":30,"w":179,"x":4,"y":120}   child of [94], correct
[27]  table "Sheet Sheet1" frame={"h":523,"w":1179,"x":33,"y":187} grid starts at y 214
[29]  page tab "Sheet1"    frame={"h":23,"w":66,"x":133,"y":725}   on screen y 752-775
[28]  button "Add"         frame={"h":23,"w":23,"x":104,"y":752}   same row as the tab, correct
```
Calc, 2×, GTK ×1: VCL parent and GTK child pairs differ by 45 px (panel `Font Name` y=125, child `DejaVu Sans`
y=170; the Name Box panel y=181, child `A1` y=226). The tab `Sheet1` is at y=1477 against `Add` at y=1522.

Calc, 2×, GTK ×2 (window at device 0,77, so logical 0,38.5): the same pairs differ by 27 logical px (panel
`Font Name` y=81, child `DejaVu Sans` y=108; Name Box panel y=118, child `A1` y=145). `File` is (0,38) 39×27, `New`
(4,40) 45×36, the tab `Sheet1` (133,725) 66×23, and `Add` (104,752) 23×23.

GTK ×2 settings (`xfconf-query`, `xdpyinfo`, `xrdb`) and window geometry (`list_windows`):
```
before: scale=1 Xft/DPI=192
after:  scale=2 Xft/DPI=96
  dimensions:    2560x1600 pixels (678x424 millimeters)
  resolution:    96x96 dots per inch
Xft.dpi:	96
window_id=48234508 pid=949 "File System - Thunar" 1280x960+1+78 app=Thunar-real
window_id=50331651 pid=971 "Terminal - @46d964706182:/" 1636x970+923+629 app=Xfce4-terminal
window_id=52428802 pid=1177 "S2 marker - Chromium" 2100x1506+20+74 app=Chromium
window_id=54525988 pid=1206 "Untitled 1 — LibreOffice Calc" 2560x1523+0+77 app=libreoffice-calc
window_id=54526639 pid=1206 "Welcome to LibreOffice!" 1374x818+593+452 app=Soffice
window_id=23068675 pid=537 "xfce4-panel" 2560x54+0+0 app=Xfce4-panel
```

Thunar, 1×, icon view:
```
              - [70] page tab "" [actions=[]]
                - directory pane = "Icon view"
                  - [71] scroll bar "" value="0.0" [actions=[]] (unlabelled scroll bar; 3rd of 6 scroll bars in this window)
```
xfce4-terminal, 1×:
```
- frame = "Terminal - @8f6d1423bd4e:/"
      - [0] menu "File" [actions=[click]] (closed menu, 0 items; click it to open)
            - [17] terminal "Terminal" (description "@8f6d1423bd4e:/") [actions=[menu]]
```
`markers.mjs`, driver frame against the pixel box:
```
1x restored  red: button frame {"h":40,"w":120,"x":58,"y":164} x1 vs pixels {"x":54,"y":164,"w":120,"h":40} -> dx 4 dy 0 dw 0 dh 0
1x maximized red: button frame {"h":40,"w":120,"x":40,"y":154} x1 vs pixels {"x":40,"y":154,"w":120,"h":40} -> dx 0 dy 0 dw 0 dh 0
2x GTK×1 restored  red: button frame {"h":80,"w":240,"x":126,"y":323} x1 vs pixels {"x":108,"y":300,"w":240,"h":80} -> dx 18 dy 23 dw 0 dh 0
2x GTK×1 maximized red: button frame {"h":80,"w":240,"x":80,"y":280} x1 vs pixels {"x":80,"y":281,"w":240,"h":80} -> dx 0 dy -1 dw 0 dh 0
2x GTK×2 restored  red: button frame {"h":80,"w":240,"x":126,"y":365} x1 vs pixels {"x":108,"y":328,"w":240,"h":80} -> dx 18 dy 37 dw 0 dh 0
2x GTK×2 maximized red: button frame {"h":80,"w":240,"x":80,"y":308} x1 vs pixels {"x":80,"y":308,"w":240,"h":80} -> dx 0 dy 0 dw 0 dh 0
(green and blue markers: the same dx/dy in every case)
```
`atspi-extents.py` (raw AT-SPI) against the driver:
```
1x Chromium  raw button 'marker red': x=54 y=164 w=120 h=40      driver {"x":58,"y":164,"w":120,"h":40}
1x Chromium  raw button 'Reload': x=92 y=83 w=34 h=34            driver {"x":92,"y":83,"w":34,"h":34}
2x GTK×1 Chromium  raw button 'marker red': x=108 y=300 w=240 h=80  driver {"x":126,"y":323,"w":240,"h":80}
2x GTK×1 Chromium  raw button 'Minimize': x=960 y=23 w=32 h=40      driver {"x":960,"y":23,"w":32,"h":40}
2x GTK×1 Calc      raw button 'New': x=4 y=51 w=81 h=61             driver {"x":4,"y":51,"w":81,"h":61}
2x GTK×1 Calc      raw page tab 'Sheet1': x=203 y=1477 w=130 h=37   driver {"x":203,"y":1477,"w":130,"h":37}
2x GTK×1 Thunar    raw button 'Home': x=1057 y=634 w=31 h=40        driver {"x":1057,"y":634,"w":31,"h":40}
2x GTK×2 Thunar    raw button 'Home': x=97 y=70 w=31 h=31           driver {"x":97,"y":70,"w":31,"h":31}
2x GTK×2 Thunar    raw menu 'File': x=0 y=39 w=39 h=27              driver {"x":0,"y":39,"w":39,"h":27}
2x GTK×2 terminal  raw menu 'File': x=461 y=314 w=39 h=27           driver {"x":461,"y":314,"w":39,"h":27}
2x GTK×2 terminal  raw terminal 'Terminal': x=461 y=341 w=802 h=458 driver {"x":461,"y":341,"w":802,"h":458}
2x GTK×2 Calc      raw button 'New': x=4 y=40 w=45 h=36             driver {"x":4,"y":40,"w":45,"h":36}
2x GTK×2 Calc      raw page tab 'Sheet1': x=133 y=725 w=66 h=23     driver {"x":133,"y":725,"w":66,"h":23}
2x GTK×2 Calc      raw button 'Add': x=104 y=752 w=23 h=23          driver {"x":104,"y":752,"w":23,"h":23}
2x GTK×2 Chromium  raw button 'marker red': x=108 y=328 w=240 h=80  driver {"x":126,"y":365,"w":240,"h":80}
2x GTK×2 Chromium  raw button 'Minimize': x=960 y=37 w=32 h=40      driver {"x":960,"y":37,"w":32,"h":40}
2x GTK×2 Chromium  raw document web 'S2 marker': x=28 y=248 w=2084 h=1324 (driver identical)
2x GTK×2 Thunar    driver screenshot_frame for Home: {"x":93,"y":-8,"w":30,"h":30}; true place in that 1237x928 shot: (186.5,59.9) 60x60
```
`get_window_state`, 7 calls each (1× first, then 2×):
```
chromium tree: 2283 2286 2236 2301 2389 2259 2227 ms; median 2283 | elements=40 walk_ms=2256
chromium full: 2333 2318 2326 2372 2228 2206 2402 ms; median 2326 | shot=1050x753
chromium shot: 37 30 30 31 29 29 32 ms; median 30
calc tree:     1119 1112 1236 1128 1140 1135 1147 ms; median 1135 | elements=249 truncated=huge_container
calc full:     1135 1148 1140 1207 1139 1287 1107 ms; median 1140 | shot=1280x750
calc shot:     42 37 37 36 36 37 36 ms; median 37
writer tree:   1181 1152 1195 1167 1197 1212 1166 ms; median 1181 | elements=238 truncated=huge_container
writer full:   1194 1195 1167 1165 1128 1118 1144 ms; median 1165
writer shot:   45 38 38 37 38 39 36 ms; median 38
thunar tree:   248 253 257 243 254 255 293 ms; median 254 | elements=75 walk_ms=219
thunar full:   254 251 242 249 281 257 257 ms; median 254 | shot=640x480
thunar shot:   32 28 27 26 29 25 25 ms; median 27
terminal tree: 96 88 87 87 82 82 84 ms; median 87 | elements=20 walk_ms=70
terminal full: 100 97 93 87 91 89 93 ms; median 93 | shot=818x485
terminal shot: 35 27 33 29 26 32 22 ms; median 29
mousepad tree: 120 121 108 105 108 109 106 ms; median 108 | elements=20 walk_ms=93
mousepad full: 125 116 116 117 123 118 115 ms; median 117 | shot=640x480
mousepad shot: 30 24 25 24 24 25 24 ms; median 24
2x chromium tree: 2109 2067 2091 2113 2135 2127 2072 ms; median 2109 | elements=51
2x chromium full: 2441 2383 2342 2310 2421 2289 2321 ms; median 2342 | shot=1367x840
2x chromium shot: 157 146 151 144 263 147 153 ms; median 151
2x calc tree:     557 572 562 526 541 545 552 ms; median 552 | elements=129 truncated=huge_container
2x calc full:     823 724 740 690 696 696 706 ms; median 706 | shot=1377x834
2x calc shot:     177 169 169 208 184 170 162 ms; median 170
2x thunar tree:   232 225 225 223 222 221 223 ms; median 223 | elements=75
2x thunar full:   238 232 228 242 234 235 234 ms; median 234 | shot=640x480
2x thunar shot:   30 30 26 25 26 30 30 ms; median 30
2x terminal tree: 87 83 76 103 101 80 80 ms; median 83 | elements=20
2x terminal full: 126 125 127 123 118 146 122 ms; median 125 | shot=1357x846
2x terminal shot: 66 63 61 61 62 61 61 ms; median 61
get_desktop_state 1x: 60 55 63 56 57 67 54 ms; median 57
get_desktop_state 2x: 244 180 209 184 183 186 181 ms; median 184
get_desktop_state 2x max_image_dimension 1280: 233 292 234 290 289 224 326 ms; median 289
```
Clicks and typing, 1×, `--no-overlay`:
```
thunar-ax:     311 305 319 296 312 319 289 ms; median 311   Clicked element [1] (pid 841).
thunar-bg:     319 293 298 329 309 316 321 ms; median 316   path=x11_atspi; hit: button "" action=click
thunar-fg:     898 886 877 882 897 906 872 ms; median 886   path=x11_xtest_fg
calc-fg:       930 893 892 907 879 881 927 ms; median 893   path=x11_xtest_fg; focus: cell C5 / B5
mousepad-type: 838 864 865 831 827 843 862 ms; median 843   Typed 1 character(s) as real key events
pointer at target: +29 ms and +35 ms after the pre-call stamp; calls took 860 and 868 ms
```
Step 6 (session `s2`) and the cursor checks:
```
click 870 ms      Clicked at (73.0, 172.0) × 1 (delivery_mode=foreground, path=x11_xtest_fg) [window_point=(73, 172) screen_point=(73, 222)]
type_text 942 ms  Typed 5 character(s) as real key events (delivery_mode=foreground, focus_after=target)
set_agent_cursor_enabled 3 ms  {"enabled":false,"session":"s2"}
get_agent_cursor_state after it: {"enabled":true, "visual_state":{"requested_action":"observe", …}}
--no-overlay (s5): {"enabled":false, …}; get_session {"cursor_visible":false, …}
```
`health_report` at 1× with the right bus: `overall ok`. `binary_version`, `platform_supported` (Ubuntu 26.04.1 LTS
(arm64)), `session_active`, `ax_capability` ("X11 reachable and org.a11y.Bus is on the session bus") and
`screen_capture_capability` passed; the macOS and Wayland checks were skipped.

After the runs, `docker rm -f ld-s2` removed the desktop. No `ld-s2` container is left, and nothing listens on
4790–4799. `localdot-spike-s2-warm` was untagged; `localdot-spike-s2` is kept.
