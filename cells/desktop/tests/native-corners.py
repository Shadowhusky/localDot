"""Render native surfaces over a changing backdrop; run with native-corners.sh.

Pixel assertions catch both a stale screenshot rectangle and a 32-bit XRGB window
mistaken for ARGB. This needs the desktop image's real GTK, rofi and compositor.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk
from PIL import Image
from Xlib import X, display

parser = argparse.ArgumentParser()
parser.add_argument("--rofi", default="rofi")
parser.add_argument("--out", default="/tmp/native-corners")
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[1]


def pump(seconds=0.35):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)
        time.sleep(0.01)


screen = Gdk.Screen.get_default()
for _ in range(50):
    pump(0.1)
    if screen.is_composited():
        break
assert screen.is_composited(), "A real compositor is required"


class Backdrop(Gtk.Window):
    color = (0.24, 0.48, 0.70)

    def do_draw(self, cr):
        cr.set_source_rgb(*self.color)
        cr.paint()
        return False


backdrop = Backdrop()
backdrop.set_decorated(False)
backdrop.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
backdrop.set_default_size(screen.get_width(), screen.get_height())
backdrop.move(0, 0)
backdrop.show_all()
pump()
x = display.Display()
root = x.screen().root


def windows(parent):
    for child in parent.query_tree().children:
        yield child
        yield from windows(child)


def find(name):
    for _ in range(30):
        for win in windows(root):
            if name in (win.get_wm_name() or "") and win.get_attributes().map_state == X.IsViewable:
                return win
        pump(0.1)
    raise AssertionError(f"Window did not appear: {name}")


def screenshot():
    native = Gdk.get_default_root_window()
    geo = native.get_geometry()
    pix = Gdk.pixbuf_get_from_window(native, 0, 0, geo.width, geo.height)
    return Image.frombytes("RGB", (pix.get_width(), pix.get_height()), pix.get_pixels(),
                           "raw", "RGB", pix.get_rowstride())


def check(name, win):
    geo = win.get_geometry()
    pos = root.translate_coords(win, 0, 0)
    left, top, width, height = pos.x, pos.y, geo.width, geo.height
    assert left >= 0 and top >= 0, (name, left, top)
    samples = [(left + dx, top + dy) for dx in (1, width - 2) for dy in (1, height - 2)]
    for i, color in enumerate(((0.24, 0.48, 0.70), (0.72, 0.36, 0.24))):
        backdrop.color = color
        backdrop.queue_draw()
        pump()
        shot = screenshot()
        shot.save(out / f"{name}-{i}.png")
        expected = shot.getpixel((10, 10))
        assert max(expected) > 100, "The backdrop was not drawn"
        for point in samples:
            actual = shot.getpixel(point)
            assert max(abs(a - b) for a, b in zip(actual, expected)) <= 3, (name, point, actual, expected)
        assert shot.getpixel((left + width // 2, top + 8)) != expected, "Missing panel"
        if name.startswith("activity-"):
            scale = int(name.rsplit("-", 1)[1])
            assert shot.getpixel((left + 8 * scale, top + 52 * scale)) == (23, 25, 28), "Multiline title grew the header"
    print(f"PASS {name}: all four corners track the live backdrop", flush=True)


def stop(process):
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=5)
    pump(0.15)


theme = (source / "root/defaults/localdot/spotlight.rasi").read_text()
for scale in (1, 2):
    scaled = re.sub(r"(\d+(?:\.\d+)?)pt\b", lambda m: str(float(m[1]) * scale) + "px", theme)
    config = out / "spotlight.rasi"
    config.write_text(scaled)
    for mode, query in (("drun", ""), ("drun", "zz-no-matching-app-zz"), ("filebrowser", "")):
        process = subprocess.Popen([args.rofi, "-show", mode, "-theme", str(config), "-filter", query])
        try:
            check(f"search-{scale}-{mode}-{'empty' if query else 'list'}", find("rofi -"))
        finally:
            stop(process)
    env = dict(os.environ, GDK_SCALE=str(scale))
    process = subprocess.Popen(["python3", str(source / "desktopd/work-window.py")],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    try:
        process.stdin.write(json.dumps({"id": 1, "visible": True, "phase": "test", "title": "First command line\nSecond line\nThird line",
                                        "text": "$ test\nOutput stays inside the Activity window"}) + "\n")
        process.stdin.flush()
        check(f"activity-{scale}", find("dot · Activity"))
    finally:
        stop(process)
backdrop.destroy()
x.close()

# Native window management uses EWMH, including apps with no accessible titlebar.
import importlib.util
spec = importlib.util.spec_from_file_location("xhelper", source / "desktopd/x/xhelper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
commands = helper.Commands(None)
window = Gtk.Window(title="Native window fixture")
window.set_default_size(480, 240)
window.show_all()
window.present()
pump()
commands.root.send_event(helper.xevent.ClientMessage(window=window.get_window().get_xid(),
    client_type=commands.NET_ACTIVE, data=(32, [2, 0, 0, 0, 0])),
    event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
commands.d.sync()
pump()
screenshot().save(out / "window-fixture.png")
wid = commands.cmd_window_control({"action": "inspect"})["windowId"]
for action in ("maximize_window", "restore_window", "minimize_window"):
    assert commands.cmd_window_control({"action": action, "windowId": wid}) == {"windowId": wid}
    pump()
    print(f"PASS native {action}: window manager confirmed state", flush=True)
window.deiconify()
window.present()
pump()
commands.root.send_event(helper.xevent.ClientMessage(window=window.get_window().get_xid(),
    client_type=commands.NET_ACTIVE, data=(32, [2, 0, 0, 0, 0])),
    event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
commands.d.sync()
pump()
for request in ({"action": "close", "windowId": wid}, {"action": "maximize_window", "windowId": wid + 1}):
    try:
        commands.cmd_window_control(request)
        raise AssertionError("An unsupported or stale action was accepted")
    except ValueError:
        pass
print("PASS native window controls: close and changed targets refused", flush=True)
window.destroy()
commands.d.close()
