#!/usr/bin/python3
"""A read-only native activity window. Input is bounded NDJSON, never executable."""
import json
import math
import time
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
gi.require_foreign("cairo")
from gi.repository import Gdk, GLib, Gtk

window = Gtk.Window(title="dot · Activity")
window.set_default_size(920, 540)
window.set_position(Gtk.WindowPosition.CENTER)
window.set_focus_on_map(False)
window.set_keep_above(True)
window.set_resizable(True)
header = Gtk.HeaderBar(title="Working on your computer", show_close_button=True)
header.set_subtitle("Live command output and file changes")
window.set_titlebar(header)
scroll = Gtk.ScrolledWindow()
scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
view = Gtk.TextView(editable=False, cursor_visible=False, monospace=True)
view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
view.set_left_margin(24)
view.set_right_margin(24)
view.set_top_margin(20)
view.set_bottom_margin(20)
scroll.add(view)
window.add(scroll)
provider = Gtk.CssProvider()
provider.load_from_data(b"""
window { background: #17191c; color: #e6e8eb; }
decoration { border: 1px solid #3b3f45; border-radius: 14px; background: #17191c; box-shadow: none; margin: 0; padding: 0; }
textview, textview text { background: #17191c; color: #e6e8eb; font: 14px monospace; }
headerbar { background: #24272b; color: #e6e8eb; border-radius: 13px 13px 0 0; border-bottom: 1px solid #35383e; }
headerbar button { color: #e6e8eb; }
scrollbar trough { background: #17191c; }
scrollbar slider { background: #55595f; min-width: 6px; border-radius: 3px; }
""")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
# A small native dot accompanies the work. Its throw and the window's entrance share one
# 260 ms clock; output updates never restart that motion or steal keyboard focus.
mascot = Gtk.DrawingArea()
mascot.set_size_request(38, 38)
mascot.set_tooltip_text("dot is working · Select and copy output below")
header.pack_start(mascot)
intro = 1.0
animation = None

def draw_dot(_widget, cr):
    lift = math.sin(intro * math.pi) * 3
    cr.set_source_rgb(0.91, 0.93, 0.96)
    cr.arc(19, 19 - lift, 13, 0, 2 * math.pi)
    cr.fill()
    cr.set_source_rgb(0.12, 0.14, 0.17)
    for x in (15, 23):
        cr.save()
        cr.translate(x, 18 - lift)
        cr.scale(1.6, 3.1)
        cr.arc(0, 0, 1, 0, 2 * math.pi)
        cr.fill()
        cr.restore()
    if intro < 1:
        cr.set_source_rgb(0.91, 0.93, 0.96)
        cr.set_line_width(2.5)
        cr.set_line_cap(1)
        cr.move_to(29, 23 - lift)
        cr.line_to(35, 21 - 9 * math.sin(intro * math.pi))
        cr.stroke()
    return False

mascot.connect("draw", draw_dot)

def stop_motion():
    global animation, intro
    if animation is not None:
        GLib.source_remove(animation)
        animation = None
    intro = 1.0
    window.set_opacity(1.0)
    mascot.queue_draw()

def enter():
    global animation, intro
    stop_motion()
    root = Gdk.get_default_root_window().get_geometry()
    width = min(920, max(240, root.width - 64))
    height = min(540, max(180, root.height - 110))
    window.resize(width, height)
    size = window.get_size()
    x, y = max(0, (root.width - size.width) // 2), max(0, (root.height - size.height) // 2)
    settings = Gtk.Settings.get_default()
    if not settings.get_property("gtk-enable-animations") or os.environ.get("LOCALDOT_REDUCED_MOTION") == "1":
        window.move(x, y)
        return False
    began = time.monotonic()
    start_x = max(0, x - 56)
    start_y = min(max(0, root.height - size.height), y + 70)
    composited = Gdk.Screen.get_default().is_composited()
    def frame():
        global animation, intro
        if not window.get_visible():
            animation = None
            return False
        intro = min(1.0, (time.monotonic() - began) / 0.26)
        ease = 1 - (1 - intro) ** 3
        window.move(round(start_x + (x - start_x) * ease), round(start_y + (y - start_y) * ease))
        if composited:
            window.set_opacity(0.7 + 0.3 * ease)
        mascot.queue_draw()
        if intro >= 1:
            animation = None
            return False
        return True
    frame()
    animation = GLib.timeout_add(16, frame)
    return False

phase = None
dismissed = None
pending = b""

def dismiss(*_args):
    global dismissed
    dismissed = phase
    stop_motion()
    window.hide()
    return True

window.connect("delete-event", dismiss)

def update(message):
    global phase
    phase = message.get("phase")
    if not message.get("visible"):
        stop_motion()
        window.hide()
    elif phase != dismissed:
        adjustment = scroll.get_vadjustment()
        follow = adjustment.get_value() + adjustment.get_page_size() >= adjustment.get_upper() - 30
        header.set_title(str(message.get("title", ""))[:240] or "Working on your computer")
        # TextBuffer does not interpret markup, terminal escapes or hyperlinks.
        content = str(message.get("text", ""))[-12000:]
        content = "".join(c if c in "\n\t" or ord(c) >= 32 else "�" for c in content)
        buffer = view.get_buffer()
        old = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), False)
        if content != old:
            if content.startswith(old):
                buffer.insert(buffer.get_end_iter(), content[len(old):])
            else:
                buffer.set_text(content)
            if follow:
                GLib.idle_add(lambda: (adjustment.set_value(max(0, adjustment.get_upper() - adjustment.get_page_size())), False)[1])
        if not window.get_visible():
            window.show_all()
            # Native root coordinates keep the window inside the actual streamed screen.
            GLib.idle_add(enter)
    Gdk.Display.get_default().sync()
    print(message.get("id", 0), flush=True)

def receive(_fd, condition):
    global pending
    chunk = os.read(sys.stdin.fileno(), 65536)
    if not chunk:
        Gtk.main_quit()
        return False
    pending += chunk
    while b"\n" in pending:
        line, pending = pending.split(b"\n", 1)
        if len(line) > 65536:
            Gtk.main_quit()
            return False
        try:
            update(json.loads(line))
        except (ValueError, TypeError):
            pass
    if len(pending) > 65536:
        Gtk.main_quit()
        return False
    return True

GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, receive)
Gtk.main()
