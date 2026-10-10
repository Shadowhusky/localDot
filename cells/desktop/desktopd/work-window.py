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
import cairo
from gi.repository import Gdk, GLib, Gtk, Pango

RADIUS = 14
HEADER_HEIGHT = 48

def rounded(cr, width, height, inset=0):
    r = RADIUS - inset
    for x, y, start in ((width-RADIUS, RADIUS, -90),
                         (width-RADIUS, height-RADIUS, 0),
                         (RADIUS, height-RADIUS, 90),
                         (RADIUS, RADIUS, 180)):
        cr.arc(x, y, r, math.radians(start), math.radians(start+90))
    cr.close_path()

class ActivityWindow(Gtk.Window):
    def do_draw(self, cr):
        width, height = self.get_allocated_width(), self.get_allocated_height()
        cr.save()
        # Erase the previous allocation's corners on the RGBA surface. Otherwise
        # resizing or expanding can leave opaque pixels outside the new outline.
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        # Paint children together, then apply one antialiased outline. Clipping
        # and painting each child separately compounds coverage at the edge.
        cr.push_group()
        cr.set_source_rgb(0.09, 0.10, 0.11)
        cr.paint()
        Gtk.Window.do_draw(self, cr)
        cr.pop_group_to_source()
        rounded(cr, width, height)
        cr.fill()
        rounded(cr, width, height, 0.5)
        cr.set_source_rgba(0.70, 0.73, 0.78, 0.28)
        cr.set_line_width(1)
        cr.stroke()
        cr.restore()
        return False

window = ActivityWindow(title="dot · Activity")
window.set_decorated(False)
window.set_app_paintable(True)
visual = window.get_screen().get_rgba_visual()
if visual:
    window.set_visual(visual)
window.set_focus_on_map(False)
window.set_keep_above(False)
window.set_resizable(True)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
root = Gdk.get_default_root_window().get_geometry()
initial_width = min(520, max(240, root.width - 32))
initial_height = min(260, max(140, root.height // 3))
window.set_default_size(initial_width, initial_height)

# X Shape regions are binary masks: use them for hit testing, but let the
# compositor blend the visible edge. Keep a bounding shape only on desktops
# without RGBA compositing, where transparent corners would otherwise be opaque.
def shape_window(_widget, allocation):
    native = window.get_window()
    if not native:
        return
    w, h = allocation.width, allocation.height
    region = cairo.Region()
    for y in range(h):
        distance = max(RADIUS-y-0.5, y+0.5-(h-RADIUS), 0)
        inset = math.ceil(RADIUS-math.sqrt(max(0, RADIUS**2-distance**2))) if distance else 0
        region.union(cairo.RectangleInt(inset, y, max(0, w-2*inset), 1))
    composited = visual is not None and window.get_screen().is_composited()
    native.shape_combine_region(None if composited else region, 0, 0)
    native.input_shape_combine_region(region, 0, 0)

window.connect("size-allocate", shape_window)

def compositing_changed(_screen):
    shape_window(window, window.get_allocation())
    window.queue_draw()

window.get_screen().connect("composited-changed", compositing_changed)
body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
window.add(body)
header = Gtk.EventBox()
header.set_name("activity-header")
header.set_size_request(-1, HEADER_HEIGHT)
row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
row.set_margin_start(12)
row.set_margin_end(8)
header.add(row)
body.pack_start(header, False, False, 0)
mascot = Gtk.DrawingArea()
mascot.set_size_request(28, 28)
mascot.set_valign(Gtk.Align.CENTER)
mascot.set_tooltip_text("dot is working")
row.pack_start(mascot, False, False, 0)
title = Gtk.Label(label="Working on your computer", xalign=0)
title.set_single_line_mode(True)
title.set_line_wrap(False)
title.set_ellipsize(Pango.EllipsizeMode.END)
title.set_valign(Gtk.Align.CENTER)
title.set_hexpand(True)
title.set_size_request(0, -1)
row.pack_start(title, True, True, 0)

def header_button(icon, tooltip):
    button = Gtk.Button.new_from_icon_name(icon, Gtk.IconSize.MENU)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.set_tooltip_text(tooltip)
    button.get_accessible().set_name(tooltip)
    button.set_size_request(32, 32)
    button.set_valign(Gtk.Align.CENTER)
    row.pack_start(button, False, False, 0)
    return button

collapse = header_button("pan-down-symbolic", "Collapse output")
close = header_button("window-close-symbolic", "Dismiss activity")
output = Gtk.Overlay()
body.pack_start(output, True, True, 0)
scroll = Gtk.ScrolledWindow()
scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
view = Gtk.TextView(editable=False, cursor_visible=False, monospace=True)
view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
view.set_left_margin(16)
view.set_right_margin(16)
view.set_top_margin(12)
view.set_bottom_margin(16)
scroll.add(view)
output.add(scroll)
grip = Gtk.EventBox()
grip.set_size_request(18, 18)
grip.set_halign(Gtk.Align.END)
grip.set_valign(Gtk.Align.END)
grip.set_margin_end(3)
grip.set_margin_bottom(3)
grip.set_tooltip_text("Resize activity")
grip_drawing = Gtk.DrawingArea()
grip.add(grip_drawing)
output.add_overlay(grip)

def draw_grip(_widget, cr):
    cr.set_source_rgba(0.7, 0.73, 0.78, 0.45)
    cr.set_line_width(1)
    for n in (5, 9):
        cr.move_to(14-n, 14)
        cr.line_to(14, 14-n)
    cr.stroke()

grip_drawing.connect("draw", draw_grip)
grip.connect("button-press-event", lambda _w, e: window.begin_resize_drag(
    Gdk.WindowEdge.SOUTH_EAST, e.button, int(e.x_root), int(e.y_root), e.time) if e.button == 1 else None)
header.connect("button-press-event", lambda _w, e: window.begin_move_drag(
    e.button, int(e.x_root), int(e.y_root), e.time) if e.button == 1 else None)
provider = Gtk.CssProvider()
provider.load_from_data(b"""
window { background: transparent; color: #e6e8eb; }
#activity-header { background: #23262a; }
#activity-header label { font: 13px sans-serif; font-weight: 500; }
button { color: #bfc4cd; padding: 0; min-width: 0; min-height: 0; border: none; box-shadow: none; }
button:hover { background: #373b42; border-radius: 8px; }
textview, textview text { background: #17191c; color: #d9dde3; font: 12px monospace; }
scrolledwindow { border: none; }
scrollbar trough { background: #17191c; }
scrollbar slider { background: #55595f; min-width: 5px; border-radius: 3px; }
""")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
intro = 1.0
animation = None
last_size = (initial_width, initial_height)
last_position = None
collapsed = False
expanded_height = initial_height

def toggle_output(*_args):
    global collapsed, expanded_height
    collapsed = not collapsed
    width, height = window.get_size()
    if collapsed:
        expanded_height = height
        output.hide()
        window.resize(width, HEADER_HEIGHT)
    else:
        output.show_all()
        window.resize(width, expanded_height)
    label = "Expand output" if collapsed else "Collapse output"
    collapse.set_tooltip_text(label)
    collapse.get_accessible().set_name(label)
    collapse.set_image(Gtk.Image.new_from_icon_name(
        "pan-up-symbolic" if collapsed else "pan-down-symbolic", Gtk.IconSize.MENU))

collapse.connect("clicked", toggle_output)

def draw_dot(widget, cr):
    x, y = widget.get_allocated_width()/2, widget.get_allocated_height()/2
    lift = math.sin(intro * math.pi) * 1.5
    cr.set_source_rgb(0.91, 0.93, 0.96)
    cr.arc(x, y-lift, 11, 0, 2 * math.pi)
    cr.fill()
    cr.set_source_rgb(0.12, 0.14, 0.17)
    for offset in (-3.4, 3.4):
        cr.save()
        cr.translate(x+offset, y-0.5-lift)
        cr.scale(1.4, 2.7)
        cr.arc(0, 0, 1, 0, 2 * math.pi)
        cr.fill()
        cr.restore()
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
    width, height = last_size
    if collapsed:
        height = HEADER_HEIGHT
    # Desktop images can apply a blanket maximize policy whenever a window maps.
    # Restore our own size and position, including the user's collapsed state.
    window.unmaximize()
    window.unfullscreen()
    window.resize(width, height)
    if last_position is None:
        x, y = root.width-width-24, root.height-height-64
    else:
        x, y = last_position
    window.move(max(0, min(x, root.width-width)), max(0, min(y, root.height-height)))
    settings = Gtk.Settings.get_default()
    if not settings.get_property("gtk-enable-animations") or os.environ.get("LOCALDOT_REDUCED_MOTION") == "1":
        return False
    began = time.monotonic()
    composited = Gdk.Screen.get_default().is_composited()
    def frame():
        global animation, intro
        if not window.get_visible():
            animation = None
            return False
        intro = min(1.0, (time.monotonic()-began)/0.18)
        if composited:
            window.set_opacity(0.8+0.2*(1-(1-intro)**3))
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

def hide_window():
    global last_size, last_position
    if window.get_visible():
        last_size = tuple(window.get_size())
        last_position = tuple(window.get_position())
    stop_motion()
    window.hide()

def dismiss(*_args):
    global dismissed
    dismissed = phase
    hide_window()
    return True

window.connect("delete-event", dismiss)
close.connect("clicked", dismiss)

def update(message):
    global phase
    phase = message.get("phase")
    if not message.get("visible"):
        hide_window()
    elif phase != dismissed:
        adjustment = scroll.get_vadjustment()
        follow = adjustment.get_value() + adjustment.get_page_size() >= adjustment.get_upper() - 30
        caption = str(message.get("title", ""))[:240] or "Working on your computer"
        # Tool titles can contain a whole multiline shell command. Keep the header
        # one line; the body and tooltip retain the original command formatting.
        title.set_text(" ".join(caption.split()))
        title.set_tooltip_text(caption)
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
            if collapsed:
                output.hide()
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
