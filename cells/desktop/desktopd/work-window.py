#!/usr/bin/python3
"""A read-only native activity window. Input is bounded NDJSON, never executable."""
import json
import os
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk

window = Gtk.Window(title="dot · Activity")
window.set_default_size(920, 540)
window.set_position(Gtk.WindowPosition.CENTER)
window.set_focus_on_map(False)
window.set_keep_above(True)
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
provider.load_from_data(b"textview, textview text { background: #17191c; color: #e6e8eb; font: 14px monospace; } headerbar { background: #24272b; color: #e6e8eb; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
phase = None
dismissed = None
pending = b""

def dismiss(*_args):
    global dismissed
    dismissed = phase
    window.hide()
    return True

window.connect("delete-event", dismiss)

def update(message):
    global phase
    phase = message.get("phase")
    if not message.get("visible"):
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
            buffer.set_text(content)
            if follow:
                GLib.idle_add(lambda: (adjustment.set_value(max(0, adjustment.get_upper() - adjustment.get_page_size())), False)[1])
        if not window.get_visible():
            window.show_all()
            # Xvfb's monitor metadata can disagree with its root size. Place the
            # actual allocated window inside the streamed root, not that metadata.
            def center():
                root = Gdk.get_default_root_window().get_geometry()
                size = window.get_size()
                window.move(max(0, (root.width - size.width) // 2), max(0, (root.height - size.height) // 2))
                return False
            GLib.idle_add(center)
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
