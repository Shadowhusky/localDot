### Task 3b: Desktop image — the macOS look (WhiteSur Light, WhiteSur icons, Plank, menu-bar panel)

The spec's "Look" is part of the desktop image (P2-R5): WhiteSur GTK theme and its xfwm4 `-hdpi`/`-xhdpi`
variants, WhiteSur icons, a Plank dock and a top panel styled as a menu bar, all in the LIGHT variant
(P2-R12: Theatre's overlays were tuned against white desktop content). Sources are pinned by commit
and verified after the clone, so no archive checksum is needed; each asset's license is recorded in
the image and in the repo (P2-R13). Facts from the pinned tag `2026-09-10` of both repositories:
the GTK repo's `release/WhiteSur-Light.tar.xz` is the pre-built theme (gtk-2.0/3.0/4.0, `xfwm4/`
at laptop size, `plank/dock.theme`); its installer builds the xfwm4 `-hdpi`/`-xhdpi` variants by
copying `src/assets/xfwm4/assets-Light-{hdpi,xhdpi}/*.png` and `src/main/xfwm4/themerc-Light`
(`libs/lib-install.sh`), which this task repeats without `sassc`; the icon repo's `install.sh -d
/usr/share/icons -t default` installs `WhiteSur`, `WhiteSur-light` and `WhiteSur-dark`; the GTK
theme's `COPYING` is the MIT text, the icon theme's `COPYING` is GPL-3.0. The screenshot checks use
ImageMagick's `import`, which Task 2 installs.

**Files:**
- Modify: `cells/desktop/Dockerfile`, `cells/desktop/root/defaults/startwm.sh`,
  `cells/desktop/root/defaults/localdot/xsettings.xml.in`, `cells/desktop/root/defaults/localdot/xfwm4.xml.in`,
  `.gitignore`
- Create: `cells/desktop/root/defaults/xfce/xfce4-panel.xml`, `cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop`,
  `cells/desktop/root/usr/local/bin/localdot-plank`, `cells/desktop/THIRD-PARTY.md`
- Test: `apps/daemon/src/cells/desktop-image.docker.test.ts` (theme assertions replace Task 3's, plus Plank and screenshots)

**Interfaces:**
- Produces: GTK theme `WhiteSur-Light`; xfwm4 themes `WhiteSur-Light` (1×) and `WhiteSur-Light-xhdpi` (2×);
  icon theme `WhiteSur`; Plank theme `WhiteSur-Light` at `/usr/share/plank/themes/WhiteSur-Light/dock.theme`,
  started by `/etc/xdg/autostart/localdot-plank.desktop` → `/usr/local/bin/localdot-plank` (bottom,
  always visible, 48 px icons at 1× / 96 px device px at 2×); the top panel is a 26 px (1×) / 54 px
  (2×) menu bar: applications menu, expanding separator, status tray, audio, clock, actions; license
  files in `/usr/share/doc/localdot-themes/`; Dockerfile ARGs `WHITESUR_GTK_TAG`, `WHITESUR_GTK_COMMIT`,
  `WHITESUR_ICONS_TAG`, `WHITESUR_ICONS_COMMIT`.

- [ ] **Step 1: Resolve the pins and the licenses**

Run:
```bash
git ls-remote --tags https://github.com/vinceliuice/WhiteSur-gtk-theme 2026-09-10
git ls-remote --tags https://github.com/vinceliuice/WhiteSur-icon-theme 2026-09-10
```
Expected (the values this plan was written against): `99247ecd219bdc1c7409baff062b4aafcf1102a7 refs/tags/2026-09-10`
for the GTK theme and `73d8040da51a9ed74e47c7366e7e9ff437601a5c refs/tags/2026-09-10` for the icon
theme. Write the printed commits into the two `*_COMMIT` ARGs below (if a `^{}` line is printed, the tag
is annotated and that line holds the commit: use it). Then confirm the licenses:
```bash
curl -fsSL https://raw.githubusercontent.com/vinceliuice/WhiteSur-gtk-theme/2026-09-10/COPYING | head -3
curl -fsSL https://raw.githubusercontent.com/vinceliuice/WhiteSur-icon-theme/2026-09-10/COPYING | head -3
```
Expected: the first prints `Copyright (c) 2021 WhiteSur Developers` followed by the MIT permission
sentence; the second prints `GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`. If either
differs, write what it says into `THIRD-PARTY.md` and the commit message; the spec's license line is
updated after execution (P2-R13).

- [ ] **Step 2: Install the themes in the image**

In `cells/desktop/Dockerfile`, after the Cua Driver `ENV` block and before `COPY root/ /`, add:
```dockerfile
ARG WHITESUR_GTK_TAG=2026-09-10
ARG WHITESUR_GTK_COMMIT=99247ecd219bdc1c7409baff062b4aafcf1102a7
ARG WHITESUR_ICONS_TAG=2026-09-10
ARG WHITESUR_ICONS_COMMIT=73d8040da51a9ed74e47c7366e7e9ff437601a5c

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends plank \
 && rm -rf /var/lib/apt/lists/*

# WhiteSur GTK theme (MIT), light variant: the repo's pre-built theme, plus the xfwm4 -hdpi/-xhdpi
# variants assembled the way its installer does (libs/lib-install.sh), so no sassc build is needed.
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_GTK_TAG" https://github.com/vinceliuice/WhiteSur-gtk-theme /tmp/whitesur-gtk; \
    test "$(git -C /tmp/whitesur-gtk rev-parse HEAD)" = "$WHITESUR_GTK_COMMIT"; \
    tar -xJf /tmp/whitesur-gtk/release/WhiteSur-Light.tar.xz -C /usr/share/themes; \
    for size in hdpi xhdpi; do \
      mkdir -p "/usr/share/themes/WhiteSur-Light-${size}/xfwm4"; \
      cp /tmp/whitesur-gtk/src/assets/xfwm4/assets-Light-${size}/*.png "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/"; \
      cp /tmp/whitesur-gtk/src/main/xfwm4/themerc-Light "/usr/share/themes/WhiteSur-Light-${size}/xfwm4/themerc"; \
    done; \
    mkdir -p /usr/share/plank/themes/WhiteSur-Light /usr/share/doc/localdot-themes; \
    cp /usr/share/themes/WhiteSur-Light/plank/dock.theme /usr/share/plank/themes/WhiteSur-Light/dock.theme; \
    cp /tmp/whitesur-gtk/COPYING /usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING; \
    rm -rf /tmp/whitesur-gtk

# WhiteSur icon theme (GPL-3.0): separately licensed data inside the image, like the base (P2-R13).
RUN set -eu; \
    git clone --depth 1 --branch "$WHITESUR_ICONS_TAG" https://github.com/vinceliuice/WhiteSur-icon-theme /tmp/whitesur-icons; \
    test "$(git -C /tmp/whitesur-icons rev-parse HEAD)" = "$WHITESUR_ICONS_COMMIT"; \
    /tmp/whitesur-icons/install.sh -d /usr/share/icons -t default; \
    cp /tmp/whitesur-icons/COPYING /usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING; \
    rm -rf /tmp/whitesur-icons
```
Also add `/usr/local/bin/localdot-plank` to the `RUN chmod 755 …` line of the `base` stage (it is
copied by `COPY root/ /`), which becomes
`RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run /usr/local/bin/localdot-plank`.

`cells/desktop/THIRD-PARTY.md`:
```markdown
# Third-party components in the desktop image

| Component | Version | License | Where |
|---|---|---|---|
| linuxserver webtop (Ubuntu 26.04, XFCE 4.20, Selkies 2.0.0) | 53afe260-ls3, `sha256:73f966bd414cd4aef183c96aba8fab37dd98715f41a278b655fee594d36bd804` | GPL-3.0-only (image), Selkies MPL-2.0 | base image |
| WhiteSur GTK theme (light) | tag 2026-09-10, commit 99247ecd219bdc1c7409baff062b4aafcf1102a7 | MIT | `/usr/share/themes/WhiteSur-Light*`, license at `/usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING` |
| WhiteSur icon theme | tag 2026-09-10, commit 73d8040da51a9ed74e47c7366e7e9ff437601a5c | GPL-3.0 (separately licensed data) | `/usr/share/icons/WhiteSur*`, license at `/usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING` |
| Plank | Ubuntu package | GPL-3.0 | `/usr/bin/plank` |
| Cua Driver | 0.30.4 | MIT | `/opt/cua`, `/usr/local/bin/cua-driver` |
| VSCodium | 1.135.06055 | MIT | `/usr/share/codium` |
| Node.js | 24.21.0 | MIT | `/opt/node` |

The localDot code in this image (`desktopd`, the s6 services, the templates) is MIT like the rest
of the repository.
```

- [ ] **Step 3: Themes in the templates, the menu-bar panel and the dock**

In `cells/desktop/root/defaults/localdot/xsettings.xml.in` replace the two `Net` names:
```xml
    <property name="ThemeName" type="string" value="WhiteSur-Light"/>
    <property name="IconThemeName" type="string" value="WhiteSur"/>
```
In `cells/desktop/root/defaults/localdot/xfwm4.xml.in` set the window buttons to macOS order (close,
minimize, maximize on the left):
```xml
    <property name="button_layout" type="string" value="CHM|"/>
```
In `cells/desktop/root/defaults/startwm.sh` map the scale to the WhiteSur xfwm4 builds:
```bash
case "$scale" in
  1) theme=WhiteSur-Light ;;
  2) theme=WhiteSur-Light-xhdpi ;;
  *) echo "startwm: LOCALDOT_SCALE must be 1 or 2, got $scale" >&2; exit 1 ;;
esac
```
(startwm.sh rewrites `xsettings.xml` and `xfwm4.xml` on every start, so a theme change made inside
the desktop does not survive a restart; that is intended — the look is localDot's, not the agent's.)

`cells/desktop/root/defaults/xfce/xfce4-panel.xml` (replaces the base's default on the first run;
size 26 stays, because GTK window scaling renders it at 54 px at 2×, as S2 measured):
```xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="icon-size" type="uint" value="16"/>
      <property name="size" type="uint" value="26"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
        <value type="int" value="4"/>
        <value type="int" value="5"/>
        <value type="int" value="6"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="show-button-title" type="bool" value="false"/>
      <property name="button-icon" type="string" value="distributor-logo"/>
    </property>
    <property name="plugin-2" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-3" type="string" value="systray">
      <property name="square-icons" type="bool" value="true"/>
    </property>
    <property name="plugin-4" type="string" value="pulseaudio">
      <property name="enable-keyboard-shortcuts" type="bool" value="true"/>
      <property name="show-notifications" type="bool" value="false"/>
    </property>
    <property name="plugin-5" type="string" value="clock">
      <property name="digital-layout" type="uint" value="3"/>
      <property name="digital-time-format" type="string" value="%a %d %b  %H:%M"/>
    </property>
    <property name="plugin-6" type="string" value="actions"/>
  </property>
</channel>
```

`cells/desktop/root/etc/xdg/autostart/localdot-plank.desktop`:
```
[Desktop Entry]
Type=Application
Name=Dock
Exec=/usr/local/bin/localdot-plank
OnlyShowIn=XFCE;
X-GNOME-Autostart-enabled=true
```

`cells/desktop/root/usr/local/bin/localdot-plank`:
```bash
#!/bin/bash
# Plank keeps its settings in dconf on the home volume; the dock's look is pinned before every start.
dock="net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/"
gsettings set "$dock" theme "'WhiteSur-Light'"
gsettings set "$dock" position "'bottom'"
gsettings set "$dock" hide-mode "'none'"
gsettings set "$dock" icon-size 48
exec plank
```

Run: `cells/desktop/build.sh`
Expected: the theme layers build (two clones, ~200 MB of icons); `docker run --rm --entrypoint ls
localdot/desktop:dev /usr/share/themes` lists `WhiteSur-Light`, `WhiteSur-Light-hdpi`,
`WhiteSur-Light-xhdpi`; `… ls /usr/share/icons` lists `WhiteSur`, `WhiteSur-dark`, `WhiteSur-light`.

- [ ] **Step 4: Update the image test and look at the desktop**

In `apps/daemon/src/cells/desktop-image.docker.test.ts` (the "session bus, HiDPI and Selkies"
describe from Task 3) change the two xfwm4 expectations — `toBe("Default-xhdpi")` becomes
`toBe("WhiteSur-Light-xhdpi")` in the 2× test and `toBe("Default")` becomes `toBe("WhiteSur-Light")`
in the 1× test — and add these tests before `"switches to 1x with LOCALDOT_SCALE=1"`:
```ts
  it("wears the WhiteSur light look with a dock and a menu-bar panel", () => {
    expect(xfconf(C2, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    expect(xfconf(C2, "xsettings", "/Net/IconThemeName")).toBe("WhiteSur");
    expect(xfconf(C2, "xfwm4", "/general/button_layout")).toBe("CHM|");
    expect(dockerExec(C2, "sh", "-c", "ls /usr/share/themes/WhiteSur-Light-xhdpi/xfwm4/themerc /usr/share/icons/WhiteSur/index.theme /usr/share/plank/themes/WhiteSur-Light/dock.theme").status).toBe(0);
    expect(dockerExec(C2, "sh", "-c", "ls /usr/share/doc/localdot-themes/WhiteSur-gtk-theme.COPYING /usr/share/doc/localdot-themes/WhiteSur-icon-theme.COPYING").status).toBe(0);
    const plugins = dockerExecAs(C2, "abc", "xfconf-query", "-c", "xfce4-panel", "-l", "-v").out;
    expect(plugins).toContain("applicationsmenu");
    expect(plugins).not.toContain("tasklist");
    expect(dockerExecAs(C2, "abc", "pgrep", "-x", "plank").status).toBe(0);
    expect(dockerExecAs(C2, "abc", "gsettings", "get", "net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/", "theme").out.trim()).toBe("'WhiteSur-Light'");
  });

  it("saves a 2x screenshot of the themed desktop for the executor to look at", () => {
    expect(dockerExecAs(C2, "abc", "sh", "-c", "import -window root /tmp/look-2x.png").status).toBe(0);
    docker("cp", `${C2}:/tmp/look-2x.png`, join(OUT, "look-2x.png"));
  });
```
and, inside the 1× test after its panel assertion:
```ts
    expect(xfconf(C1, "xsettings", "/Net/ThemeName")).toBe("WhiteSur-Light");
    expect(dockerExecAs(C1, "abc", "sh", "-c", "import -window root /tmp/look-1x.png").status).toBe(0);
    docker("cp", `${C1}:/tmp/look-1x.png`, join(OUT, "look-1x.png"));
```
Near the top of the file add `const OUT = fileURLToPath(new URL("./testing/out/", import.meta.url));`
and add `mkdirSync(OUT, { recursive: true })` at the top of the describe (import `mkdirSync` from
`node:fs`, `join` from `node:path` and `fileURLToPath` from `node:url`). In `.gitignore`, append
`apps/daemon/src/cells/testing/out/` and drop the lines `cells/desktop/desktopd/dist/` and
`apps/web/dist/` that Task 1 added (the existing `dist/` line already covers both).

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: 15 tests pass. Open `look-2x.png` and `look-1x.png` in
`apps/daemon/src/cells/testing/out/` and check: WhiteSur's light window
chrome with the traffic-light buttons on the left of the title bar, a light top panel with the
applications icon left and tray/clock right, and the Plank dock centred at the bottom; the 2× image
is 2560×1600 with the panel 54 px tall. If Plank draws an opaque rectangle behind its icons (it is
designed for a compositing window manager; xfwm4's compositor is off in the template), set
`use_compositing` to `true` in `xfwm4.xml.in`, rebuild, re-run, and record the container CPU
difference in the Task 15 measurement note.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/desktop-image.docker.test.ts .gitignore
git commit -m "feat(desktop): WhiteSur light look with Plank and a menu-bar panel"
```

---
