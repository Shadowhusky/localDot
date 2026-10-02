### Task 3: Desktop image — one session D-Bus, HiDPI XFCE at 2× (1× switchable), locked Selkies settings

The base starts XFCE with `dbus-launch --exit-with-session`, so the session bus has a random
address, and anything started without it autolaunches a second bus that can take over the
accessibility bus (S2). This task runs one `dbus-daemon --session` at a fixed address known to every
process in the container, writes the HiDPI xfconf settings from templates on every start, and bakes
the Selkies settings in. Facts from the base image used here: `svc-de` sets the X resolution from
`SELKIES_MANUAL_WIDTH/HEIGHT` with xrandr before running `/defaults/startwm.sh` as `abc`; nginx on
port 3000 serves the client and proxies `/api` to Selkies, and `PASSWORD` + `CUSTOM_USER` turn on
nginx basic auth for the whole site; Selkies reads `SELKIES_SCALING_DPI` at startup and, for XFCE,
writes `Xft/DPI` with `xfconf-query` inside the xfce4-session's environment; a single enum value
(`96`) locks it and makes Selkies ignore the client's DPI sync; bools take a `|locked` suffix.

**Files:**
- Create: `cells/desktop/root/defaults/startwm.sh`, `cells/desktop/root/defaults/xfce/thunar.xml`
- Create: `cells/desktop/root/defaults/localdot/xsettings.xml.in`, `cells/desktop/root/defaults/localdot/xfwm4.xml.in`,
  `cells/desktop/root/defaults/localdot/registrymodifications.xcu`
- Create: `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/type`, `.../svc-session-bus/run`,
  `.../svc-session-bus/dependencies.d/init-services`, `.../svc-de/dependencies.d/svc-session-bus`,
  `.../svc-selkies/dependencies.d/svc-session-bus`, `.../user/contents.d/svc-session-bus`
- Modify: `cells/desktop/Dockerfile` (COPY root, ENV block)
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts` (part 2)

**Interfaces:**
- Produces: container env `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus` (every
  process, `docker exec` included); `LOCALDOT_SCALE=1|2` chooses the HiDPI templates at start
  (default 2, with `SELKIES_MANUAL_WIDTH/HEIGHT` 2560×1600; the orchestrator passes 1280×800 for 1);
  nginx basic auth user `localdot` with the password from `PASSWORD`; Selkies at `/api/websockets`
  on port 3000 behind that auth.

- [ ] **Step 1: Write the session-bus service and the XFCE start script**

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/type`:
```
longrun
```

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-session-bus/run`:
```bash
#!/usr/bin/with-contenv bash
# The one session bus of this desktop, at the address every process in the container carries.
sock="${DBUS_SESSION_BUS_ADDRESS#unix:path=}"
rm -f "$sock"
exec s6-setuidgid abc dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
```

Create these empty files (`touch`): `svc-session-bus/dependencies.d/init-services`,
`svc-de/dependencies.d/svc-session-bus`, `svc-selkies/dependencies.d/svc-session-bus`,
`user/contents.d/svc-session-bus` (all under `cells/desktop/root/etc/s6-overlay/s6-rc.d/`).

`cells/desktop/root/defaults/startwm.sh`:
```bash
#!/bin/bash
# Replaces the base's startwm.sh: no dbus-launch (svc-session-bus owns the bus), and the HiDPI
# settings follow LOCALDOT_SCALE on every start so a cell can switch between 2x and 1x.
set -eu
conf="${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
if [ ! -d "$conf" ]; then
  mkdir -p "$conf"
  cp /defaults/xfce/*.xml "$conf"/
fi
# LibreOffice's first-run dialogs are modal and invisible to the accessibility tree (S2).
lo="${HOME}/.config/libreoffice/4/user"
if [ ! -f "$lo/registrymodifications.xcu" ]; then
  mkdir -p "$lo"
  cp /defaults/localdot/registrymodifications.xcu "$lo"/
fi
# The two files below are rewritten on every start: a theme change made inside the desktop does
# not survive a restart, on purpose (the look is localDot's, not the agent's).
scale="${LOCALDOT_SCALE:-2}"
case "$scale" in
  1) theme=Default ;;
  2) theme=Default-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
sed "s/@SCALE@/$scale/g" /defaults/localdot/xsettings.xml.in > "$conf/xsettings.xml"
sed "s/@THEME@/$theme/g" /defaults/localdot/xfwm4.xml.in > "$conf/xfwm4.xml"
# xfconfd caches channels in memory: one started before this copy (Selkies' DPI restore can
# activate it) would write stale values back over these files.
pkill -u "$(id -u)" -x xfconfd || true
exec /usr/bin/xfce4-session
```

- [ ] **Step 2: Write the xfconf templates**

`cells/desktop/root/defaults/localdot/xsettings.xml.in` (`Gdk/WindowScalingFactor` from
`LOCALDOT_SCALE`, `Xft/DPI` pinned to 96 to agree with `SELKIES_SCALING_DPI=96`):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Greybird-dark"/>
    <property name="IconThemeName" type="string" value="elementary-xfce-dark"/>
    <property name="CursorBlink" type="bool" value="true"/>
    <property name="EnableEventSounds" type="bool" value="false"/>
    <property name="EnableInputFeedbackSounds" type="bool" value="false"/>
  </property>
  <property name="Xft" type="empty">
    <property name="DPI" type="int" value="96"/>
    <property name="Antialias" type="int" value="1"/>
    <property name="Hinting" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="none"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Inter 10"/>
    <property name="MonospaceFontName" type="string" value="JetBrains Mono 10"/>
  </property>
  <property name="Gdk" type="empty">
    <property name="WindowScalingFactor" type="int" value="@SCALE@"/>
  </property>
</channel>
```

`cells/desktop/root/defaults/localdot/xfwm4.xml.in` — the base image's `/defaults/xfce/xfwm4.xml`
with `theme` and `title_font` changed:
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
    <property name="activate_action" type="string" value="bring"/>
    <property name="borderless_maximize" type="bool" value="true"/>
    <property name="box_move" type="bool" value="false"/>
    <property name="box_resize" type="bool" value="false"/>
    <property name="button_layout" type="string" value="O|SHMC"/>
    <property name="button_offset" type="int" value="0"/>
    <property name="button_spacing" type="int" value="0"/>
    <property name="click_to_focus" type="bool" value="true"/>
    <property name="cycle_apps_only" type="bool" value="false"/>
    <property name="cycle_draw_frame" type="bool" value="true"/>
    <property name="cycle_raise" type="bool" value="false"/>
    <property name="cycle_hidden" type="bool" value="true"/>
    <property name="cycle_minimum" type="bool" value="true"/>
    <property name="cycle_minimized" type="bool" value="false"/>
    <property name="cycle_preview" type="bool" value="true"/>
    <property name="cycle_tabwin_mode" type="int" value="0"/>
    <property name="cycle_workspaces" type="bool" value="false"/>
    <property name="double_click_action" type="string" value="maximize"/>
    <property name="double_click_distance" type="int" value="5"/>
    <property name="double_click_time" type="int" value="250"/>
    <property name="easy_click" type="string" value="Alt"/>
    <property name="focus_delay" type="int" value="250"/>
    <property name="focus_hint" type="bool" value="true"/>
    <property name="focus_new" type="bool" value="true"/>
    <property name="frame_opacity" type="int" value="100"/>
    <property name="frame_border_top" type="int" value="0"/>
    <property name="full_width_title" type="bool" value="true"/>
    <property name="horiz_scroll_opacity" type="bool" value="false"/>
    <property name="inactive_opacity" type="int" value="100"/>
    <property name="maximized_offset" type="int" value="0"/>
    <property name="mousewheel_rollup" type="bool" value="true"/>
    <property name="move_opacity" type="int" value="100"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="20"/>
    <property name="popup_opacity" type="int" value="100"/>
    <property name="prevent_focus_stealing" type="bool" value="false"/>
    <property name="raise_delay" type="int" value="250"/>
    <property name="raise_on_click" type="bool" value="true"/>
    <property name="raise_on_focus" type="bool" value="false"/>
    <property name="raise_with_any_button" type="bool" value="true"/>
    <property name="repeat_urgent_blink" type="bool" value="false"/>
    <property name="resize_opacity" type="int" value="100"/>
    <property name="scroll_workspaces" type="bool" value="true"/>
    <property name="shadow_delta_height" type="int" value="0"/>
    <property name="shadow_delta_width" type="int" value="0"/>
    <property name="shadow_delta_x" type="int" value="0"/>
    <property name="shadow_delta_y" type="int" value="-3"/>
    <property name="shadow_opacity" type="int" value="50"/>
    <property name="show_app_icon" type="bool" value="false"/>
    <property name="show_dock_shadow" type="bool" value="true"/>
    <property name="show_frame_shadow" type="bool" value="true"/>
    <property name="show_popup_shadow" type="bool" value="false"/>
    <property name="snap_resist" type="bool" value="false"/>
    <property name="snap_to_border" type="bool" value="true"/>
    <property name="snap_to_windows" type="bool" value="false"/>
    <property name="snap_width" type="int" value="10"/>
    <property name="vblank_mode" type="string" value="auto"/>
    <property name="theme" type="string" value="@THEME@"/>
    <property name="tile_on_move" type="bool" value="true"/>
    <property name="title_alignment" type="string" value="center"/>
    <property name="title_font" type="string" value="Inter Bold 9"/>
    <property name="title_horizontal_offset" type="int" value="0"/>
    <property name="titleless_maximize" type="bool" value="false"/>
    <property name="title_shadow_active" type="string" value="false"/>
    <property name="title_shadow_inactive" type="string" value="false"/>
    <property name="title_vertical_offset_active" type="int" value="0"/>
    <property name="title_vertical_offset_inactive" type="int" value="0"/>
    <property name="toggle_workspaces" type="bool" value="false"/>
    <property name="unredirect_overlays" type="bool" value="true"/>
    <property name="urgent_blink" type="bool" value="false"/>
    <property name="workspace_count" type="int" value="1"/>
    <property name="wrap_cycle" type="bool" value="true"/>
    <property name="wrap_layout" type="bool" value="true"/>
    <property name="wrap_resistance" type="int" value="10"/>
    <property name="wrap_windows" type="bool" value="false"/>
    <property name="wrap_workspaces" type="bool" value="false"/>
    <property name="zoom_desktop" type="bool" value="true"/>
    <property name="zoom_pointer" type="bool" value="true"/>
    <property name="workspace_names" type="array">
      <value type="string" value="Workspace 1"/>
    </property>
  </property>
</channel>
```

`cells/desktop/root/defaults/localdot/registrymodifications.xcu` (seeded once into the LibreOffice
profile; turns off the "Welcome" first-run and "Tip of the Day" dialogs):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
```

`cells/desktop/root/defaults/xfce/thunar.xml` (copied with the other `/defaults/xfce/*.xml` on the
first run; Thunar's icon view has no items in the accessibility tree, A10):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="thunar" version="1.0">
  <property name="default-view" type="string" value="ThunarDetailsView"/>
  <property name="last-view" type="string" value="ThunarDetailsView"/>
</channel>
```

- [ ] **Step 3: Add the overlay and the settings to the Dockerfile**

In `cells/desktop/Dockerfile`, after the Cua Driver `ENV` block and before the `selkies-client`
stage, add:
```dockerfile
COPY root/ /
RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run

# One session bus for XFCE, AT-SPI, Selkies' xfconf writes and desktopd (A10). The Selkies values
# are locked where the client could change them; "|locked" is Selkies' bool suffix (D1, D2).
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus \
    LOCALDOT_SCALE=2 \
    SELKIES_MANUAL_WIDTH=2560 \
    SELKIES_MANUAL_HEIGHT=1600 \
    SELKIES_ENABLE_RESIZE="false|locked" \
    SELKIES_USE_CSS_SCALING="false|locked" \
    SELKIES_SCALING_DPI=96 \
    SELKIES_ENABLE_CURSORS="false|locked" \
    SELKIES_ENCODER=h264enc \
    SELKIES_FRAMERATE=60 \
    SELKIES_VIDEO_FULLCOLOR=true \
    SELKIES_AUDIO_ENABLED=false \
    SELKIES_MICROPHONE_ENABLED=false \
    SELKIES_WEBCAM_ENABLED=false \
    SELKIES_GAMEPAD_ENABLED=false \
    SELKIES_ENABLE_CLIPBOARD=false \
    SELKIES_FILE_TRANSFERS= \
    SELKIES_PRINTING_ENABLED=false \
    SELKIES_COMMAND_ENABLED=false \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_UI_SHOW_CORE_BUTTONS=false \
    SELKIES_UI_SHOW_LOGO=false \
    SELKIES_UI_TITLE=localDot \
    NO_GAMEPAD=1 \
    NO_WEBCAM=1 \
    CUSTOM_USER=localdot
```

Run: `cells/desktop/build.sh`
Expected: only the new layers build (the apt and download layers are cached).

- [ ] **Step 4: Write the image test (part 2: session, HiDPI, Selkies)**

Append to `apps/daemon/src/cells/desktop-image.docker.test.ts`:
```ts
const STREAM_PASSWORD = "p".repeat(43);

function startDesktop(name: string, scale: 1 | 2): { port: number } {
  removeAll({ containers: [name] });
  const [w, h] = scale === 2 ? ["2560", "1600"] : ["1280", "800"];
  docker("run", "-d", "--name", name, "--shm-size=1g", "--cap-drop", "NET_RAW",
    "-p", "127.0.0.1:0:3000", "-e", `PASSWORD=${STREAM_PASSWORD}`,
    "-e", `LOCALDOT_SCALE=${scale}`, "-e", `SELKIES_MANUAL_WIDTH=${w}`, "-e", `SELKIES_MANUAL_HEIGHT=${h}`,
    DESKTOP_IMAGE);
  waitFor("xfce4-panel", () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0, 180_000);
  sleepSync(5000);
  return { port: publishedPort(name, "3000") };
}

const xfconf = (name: string, channel: string, prop: string) =>
  dockerExecAs(name, "abc", "xfconf-query", "-c", channel, "-p", prop).out.trim();

function panelGeometry(name: string): { WIDTH: number; HEIGHT: number }[] {
  const ids = dockerExecAs(name, "abc", "xdotool", "search", "--classname", "xfce4-panel").out.trim();
  return ids.split("\n").filter(Boolean).map((id) => {
    const out = dockerExecAs(name, "abc", "xdotool", "getwindowgeometry", "--shell", id).out;
    const pick = (key: string) => Number(/^(?:WIDTH|HEIGHT)=(\d+)$/m.exec(out.split("\n").find((l) => l.startsWith(`${key}=`)) ?? "")?.[1]);
    return { WIDTH: pick("WIDTH"), HEIGHT: pick("HEIGHT") };
  });
}

describe.skipIf(!DOCKER_TESTS)("desktop image: session bus, HiDPI and Selkies", () => {
  const C2 = "localdot-test-desktop-2x";
  const C1 = "localdot-test-desktop-1x";
  let port2 = 0;

  beforeAll(() => {
    port2 = startDesktop(C2, 2).port;
  });
  afterAll(() => removeAll({ containers: [C2, C1] }));

  it("runs exactly one session bus at the fixed address and no dbus-launch", () => {
    expect(dockerExec(C2, "pgrep", "-c", "-f", "dbus-daemon --session").out.trim()).toBe("1");
    expect(dockerExec(C2, "pgrep", "-c", "-x", "dbus-launch").out.trim()).toBe("0");
    expect(dockerExecAs(C2, "abc", "sh", "-c", "test -S /tmp/localdot-session-bus").status).toBe(0);
    expect(dockerExecAs(C2, "abc", "printenv", "DBUS_SESSION_BUS_ADDRESS").out.trim())
      .toBe("unix:path=/tmp/localdot-session-bus");
  });

  it("has AT-SPI on that bus", () => {
    expect(dockerExecAs(C2, "abc", "xprop", "-root", "AT_SPI_BUS").out).toContain("unix:");
    expect(dockerExec(C2, "pgrep", "-c", "-f", "at-spi-bus-launcher").out.trim()).toBe("1");
  });

  it("renders HiDPI XFCE at 2x: window scaling 2, Xft/DPI 96, xhdpi theme, doubled panel", () => {
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C2, "xfwm4", "/general/theme")).toBe("Default-xhdpi");
    expect(dockerExecAs(C2, "abc", "xdpyinfo").out).toMatch(/dimensions:\s+2560x1600/);
    expect(panelGeometry(C2)).toContainEqual({ WIDTH: 2560, HEIGHT: 54 });
  });

  it("starts Selkies fixed at 2560x1600 with audio off and the stream behind basic auth", async () => {
    const log = docker("logs", C2);
    expect(log).toContain("fixed 2560x1600");
    expect(log).toContain("audio off");
    const basic = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
    expect((await fetch(`http://127.0.0.1:${port2}/`)).status).toBe(401);
    const page = await fetch(`http://127.0.0.1:${port2}/`, { headers: { authorization: basic } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("selkies-core");
    const health = await fetch(`http://127.0.0.1:${port2}/api/health`, { headers: { authorization: basic } });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port2}/api/health`)).status).toBe(401);
  });

  it("keeps the HiDPI settings while a stream socket is open", async () => {
    const basic = `Basic ${Buffer.from(`localdot:${STREAM_PASSWORD}`).toString("base64")}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/api/websockets`, { headers: { authorization: basic } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    sleepSync(3000);
    ws.close();
    expect(xfconf(C2, "xsettings", "/Gdk/WindowScalingFactor")).toBe("2");
    expect(xfconf(C2, "xsettings", "/Xft/DPI")).toBe("96");
  });

  it("opens Thunar in list view", () => {
    expect(xfconf(C2, "thunar", "/default-view")).toBe("ThunarDetailsView");
    expect(xfconf(C2, "thunar", "/last-view")).toBe("ThunarDetailsView");
  });

  it("seeds the LibreOffice profile so no first-run dialog appears", () => {
    const xcu = dockerExecAs(C2, "abc", "cat", "/config/.config/libreoffice/4/user/registrymodifications.xcu").out;
    expect(xcu).toContain('oor:name="FirstRun"');
    expect(xcu).toContain('oor:name="ShowTipOfTheDay"');
  });

  it("switches to 1x with LOCALDOT_SCALE=1", () => {
    removeAll({ containers: [C2] });
    startDesktop(C1, 1);
    expect(xfconf(C1, "xsettings", "/Gdk/WindowScalingFactor")).toBe("1");
    expect(xfconf(C1, "xsettings", "/Xft/DPI")).toBe("96");
    expect(xfconf(C1, "xfwm4", "/general/theme")).toBe("Default");
    expect(dockerExecAs(C1, "abc", "xdpyinfo").out).toMatch(/dimensions:\s+1280x800/);
    expect(panelGeometry(C1)).toContainEqual({ WIDTH: 1280, HEIGHT: 26 });
  });
});
```
Add `publishedPort`, `sleepSync` and `waitFor` to the import from `./testing/docker-cli.ts` at the
top of the file, and `import { WebSocket } from "ws";` (the daemon already depends on `ws`). The
full-client check of the DPI lock (a real Selkies client connected) is the e2e test of Task 15,
which reads the same two xfconf values after the stage goes live.

- [ ] **Step 5: Run it**

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 13 tests pass (5 from part 1, 8 here). The whole file takes about 2–3 minutes (two
desktop starts). If `panelGeometry` lists no 2560-wide window, run
`docker exec -u abc localdot-test-desktop-2x xdotool search --classname xfce4-panel` by hand and
compare the geometry of each id; the panel's main window is the one as wide as the screen.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts
git commit -m "feat(desktop): one session bus, HiDPI XFCE at 2x and locked Selkies settings"
```

---
