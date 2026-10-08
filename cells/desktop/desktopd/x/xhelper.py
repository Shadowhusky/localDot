"""localDot desktopd X helper: XTest injection, window activation, XI2 raw-press stamps and settle
(DAMAGE, window changes, app pings).

Runs as the desktop user with DISPLAY set. JSON lines over stdio:
  request  {"id": 1, "cmd": "click", ...} -> {"id": 1, "ok": true, ...} | {"id": 1, "ok": false, "error": "..."}
  event    {"ev": "press"|"release", "kind": "button"|"key", "detail": 1, "mono": 12345.678}
Times are CLOCK_MONOTONIC milliseconds (time.monotonic_ns() / 1e6), the clock desktopd's Node
process reads through process.hrtime, so nothing inside the cell needs a clock mapping.
Two X connections: `cmd` serves requests on the main thread, `evt` feeds the listener thread.
"""
import collections
import json
import select
import sys
import threading
import time

from Xlib import X, display
from Xlib.ext import damage, ge, xinput
from Xlib.protocol import event as xevent
from Xlib.protocol import rq

ACTIVATE_TIMEOUT_MS = 300
DOUBLE_CLICK_GAP_MS = 90
# Damage inside a rect that was already changing this long before arm() (a spinner, a clock) is
# ambient. Settle's quiet window is 250 ms, so the previous action's own changes have stopped
# before the next arm and are not mistaken for ambient ones.
AMBIENT_MS = 300
# A rect that changed again and again in this window, AMBIENT_MS or more apart, is ambient too:
# a caret blinks every 400-800 ms, so the short window alone catches it only half the time.
PERIODIC_MS = 1500
# Damage inside an ambient rect up to this share of the screen is ambient. A larger rect masks only
# damage of exactly its size and place, and only when it repeats: GIMP's marching ants repaint a
# third of the screen every 200 ms, while a brush dab inside them must still count.
AMBIENT_MAX_SHARE = 1 / 16
HISTORY_LIMIT = 1024
# Inputs an app handles on its main loop: settle pings that app and waits for the answer, so a
# dialog it spends a second building after the click is not missed.
PING_VERBS = ("click", "scroll", "key", "type")
TINY_WINDOW_PX = 16

RAW_EVENTS = {
    xinput.RawKeyPress: ("press", "key"),
    xinput.RawKeyRelease: ("release", "key"),
    xinput.RawButtonPress: ("press", "button"),
    xinput.RawButtonRelease: ("release", "button"),
}
# python-xlib 0.33 parses XI2 device events but not raw events; this is the XI 2.1 RawEvent wire
# layout after the GenericEvent header (deviceid, time, detail, sourceid, valuators_len, flags, pad).
RawEventData = rq.Struct(
    rq.Card16("deviceid"),
    rq.Card32("time"),
    rq.Card32("detail"),
    rq.Card16("sourceid"),
    rq.Card16("valuators_len"),
    rq.Card32("flags"),
    rq.Pad(4),
)

KEYSYMS = {
    "Return": 0xFF0D, "Tab": 0xFF09, "BackSpace": 0xFF08, "Escape": 0xFF1B, "Delete": 0xFFFF,
    "Insert": 0xFF63, "space": 0x20, "Up": 0xFF52, "Down": 0xFF54, "Left": 0xFF51, "Right": 0xFF53,
    "Home": 0xFF50, "End": 0xFF57, "Prior": 0xFF55, "Next": 0xFF56, "Menu": 0xFF67, "Print": 0xFF61,
    "Control_L": 0xFFE3, "Shift_L": 0xFFE1, "Alt_L": 0xFFE9, "Super_L": 0xFFEB, "ISO_Level3_Shift": 0xFE03,
}
for _i in range(1, 13):
    KEYSYMS["F%d" % _i] = 0xFFBE + _i - 1
MODS_FOR_INDEX = {0: [], 1: ["Shift_L"], 2: ["ISO_Level3_Shift"], 3: ["Shift_L", "ISO_Level3_Shift"]}

out_lock = threading.Lock()


def mono():
    return time.monotonic_ns() / 1e6


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def keysym_for_char(ch):
    cp = ord(ch)
    if ch == "\n":
        return KEYSYMS["Return"]
    if ch == "\t":
        return KEYSYMS["Tab"]
    if 0x20 <= cp <= 0x7E or 0xA0 <= cp <= 0xFF:
        return cp
    return 0x1000000 | cp


def merge_rects(rects, limit=8):
    """Unions rectangles that touch within 8 px; above `limit` boxes, one bounding box."""
    boxes = [list(r) for r in rects]
    merged = True
    while merged and len(boxes) > 1:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                near = (a[0] <= b[0] + b[2] + 8 and b[0] <= a[0] + a[2] + 8
                        and a[1] <= b[1] + b[3] + 8 and b[1] <= a[1] + a[3] + 8)
                if near:
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    boxes[i] = [x0, y0, x1 - x0, y1 - y0]
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    if len(boxes) > limit:
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[0] + b[2] for b in boxes)
        y1 = max(b[1] + b[3] for b in boxes)
        boxes = [[x0, y0, x1 - x0, y1 - y0]]
    return boxes


def intersects(a, b):
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def same(a, b, slack=2):
    return all(abs(a[i] - b[i]) <= slack for i in range(4))


def contains(outer, inner, slack=2):
    return (inner[0] >= outer[0] - slack and inner[1] >= outer[1] - slack
            and inner[0] + inner[2] <= outer[0] + outer[2] + slack
            and inner[1] + inner[3] <= outer[1] + outer[3] + slack)


def clip(rect, size):
    """The part of `rect` on a `size` screen, or None when too little of it is on the screen."""
    if rect is None:
        return None
    x0, y0 = max(0, rect[0]), max(0, rect[1])
    x1, y1 = min(size[0], rect[0] + rect[2]), min(size[1], rect[1] + rect[3])
    if x1 <= x0 or y1 <= y0 or (x1 - x0) * (y1 - y0) < TINY_WINDOW_PX:
        return None
    return [x0, y0, x1 - x0, y1 - y0]


Snapshot = collections.namedtuple("Snapshot", "rects last count unpainted pong")


class Screen:
    """Damage, window changes and app pongs since the last arm(), filled by the listener thread.

    Damage inside a rect that was ambient at arm() neither counts nor holds settle open. A window
    mapped after arm() holds settle until damage lands inside it, that is until it has painted.
    """

    def __init__(self, clock=mono):
        self.lock = threading.Lock()
        self.clock = clock
        self.size = (2560, 1600)
        self.recent = []
        self.ambient = []
        self.rects = []
        self.last = None
        self.count = 0
        self.unpainted = {}
        self.pongs = {}

    def _change(self, rect, t):
        if rect is not None:
            self.rects.append(rect)
            if len(self.rects) > 256:
                self.rects = merge_rects(self.rects)
        self.last = t
        self.count += 1

    def add(self, rect, t):
        with self.lock:
            self.recent.append((t, rect))
            if len(self.recent) > HISTORY_LIMIT:
                self.recent = [(at, r) for at, r in self.recent if at >= t - PERIODIC_MS]
                del self.recent[:-HISTORY_LIMIT]
            if any(same(a, rect) if large else contains(a, rect) for a, large in self.ambient):
                return
            self._change(rect, t)
            for wid, (area, since) in list(self.unpainted.items()):
                if t >= since and intersects(area, rect):
                    del self.unpainted[wid]

    def mapped(self, wid, rect, t):
        with self.lock:
            self._change(rect, t)
            self.unpainted[wid] = (rect, t)

    def unmapped(self, wid, rect, t):
        with self.lock:
            self._change(rect, t)
            self.unpainted.pop(wid, None)

    def moved(self, rect, t):
        with self.lock:
            self._change(rect, t)

    def expect(self, token):
        with self.lock:
            self.pongs[token] = None

    def pong(self, token, t):
        with self.lock:
            if token in self.pongs and self.pongs[token] is None:
                self.pongs[token] = t

    def arm(self):
        with self.lock:
            now = self.clock()
            self.recent = [(t, r) for t, r in self.recent if t >= now - PERIODIC_MS]
            seen = {}
            for t, r in self.recent:
                first, _ = seen.get(tuple(r), (t, t))
                seen[tuple(r)] = (first, t)
            limit = self.size[0] * self.size[1] * AMBIENT_MAX_SHARE
            self.ambient = []
            for r, (first, last) in seen.items():
                large = r[2] * r[3] > limit
                periodic = last - first >= AMBIENT_MS
                if periodic or (last >= now - AMBIENT_MS and not large):
                    self.ambient.append((list(r), large))
            del self.ambient[256:]
            self.rects = []
            self.last = None
            self.count = 0
            self.unpainted = {}
            self.pongs = {}
            return now

    def snapshot(self, token=None):
        with self.lock:
            return Snapshot(list(self.rects), self.last, self.count, bool(self.unpainted),
                            self.pongs.get(token))


class Listener(threading.Thread):
    def __init__(self, screen):
        super().__init__(daemon=True)
        self.screen = screen
        self.ready = threading.Event()
        self.error = None
        self.geometry = {}
        self.viewable = set()

    def run(self):
        try:
            d = display.Display()
            root = d.screen().root
            opcode = d.display.get_extension_major("XInputExtension")
            # XI 2.2, not the 2.0 that python-xlib's xinput_query_version announces: XI2proto gives
            # a 2.0 client raw events only while the device is not grabbed.
            xinput.XIQueryVersion(display=d.display, opcode=opcode, major_version=2, minor_version=2)
            for evtype in RAW_EVENTS:
                d.ge_add_event_data(opcode, evtype, RawEventData)
            mask = (xinput.RawKeyPressMask | xinput.RawKeyReleaseMask
                    | xinput.RawButtonPressMask | xinput.RawButtonReleaseMask)
            root.xinput_select_events([(xinput.AllDevices, mask)])
            damage_id = root.damage_create(damage.DamageReportRawRectangles)
            # Window frames and override-redirect popups are the root's children; an app answers
            # _NET_WM_PING by sending the message back to the root.
            root.change_attributes(event_mask=X.SubstructureNotifyMask)
            self.WM_PROTOCOLS = d.intern_atom("WM_PROTOCOLS")
            self.NET_WM_PING = d.intern_atom("_NET_WM_PING")
            g = root.get_geometry()
            self.screen.size = (g.width, g.height)
            for child in root.query_tree().children:
                rect = self.visible_rect(child)
                if rect is not None:
                    self.viewable.add(child.id)
                    self.geometry[child.id] = rect
            d.sync()
            self.ready.set()
            seen = 0
            while True:
                ev = d.next_event()
                t = mono()
                # python-xlib clones extension event classes when registering them. Match the
                # registered wire codes, not isinstance against the original module classes.
                if ev.type == ge.GenericEventCode and ev.extension == opcode and ev.evtype in RAW_EVENTS:
                    # AllDevices delivers each input twice, from the slave device and from its
                    # master; the slave's copy (deviceid == sourceid) is the one press.
                    if ev.data.deviceid != ev.data.sourceid:
                        continue
                    what, kind = RAW_EVENTS[ev.evtype]
                    emit({"ev": what, "kind": kind, "detail": int(ev.data.detail), "mono": t})
                elif ev.type == d.extension_event.DamageNotify:
                    a = ev.area
                    self.screen.add([a.x, a.y, a.width, a.height], t)
                    seen += 1
                    # Raw rectangles arrive without a subtract; the server's region still grows.
                    if seen % 32 == 0:
                        d.damage_subtract(damage_id, X.NONE, X.NONE)
                else:
                    self.window_event(ev, t)
        except Exception as err:  # noqa: BLE001 - reported to desktopd, which restarts the helper
            self.error = "%s: %s" % (type(err).__name__, err)
            self.ready.set()
            emit({"ev": "fatal", "error": "listener: " + self.error})

    def visible_rect(self, win):
        """A viewable InputOutput window's rect on the screen; None for any other window."""
        try:
            attrs = win.get_attributes()
            if attrs.win_class == X.InputOnly or attrs.map_state != X.IsViewable:
                return None
            g = win.get_geometry()
        except Exception:  # noqa: BLE001 - a window that vanished before the query
            return None
        return clip([g.x, g.y, g.width + 2 * g.border_width, g.height + 2 * g.border_width],
                    self.screen.size)

    def window_event(self, ev, t):
        if ev.type == X.ClientMessage:
            fmt, data = ev.data
            if ev.client_type == self.WM_PROTOCOLS and fmt == 32 and data[0] == self.NET_WM_PING:
                self.screen.pong(int(data[1]), t)
            return
        window = getattr(ev, "window", None)
        wid = getattr(window, "id", None)
        if ev.type == X.MapNotify:
            rect = self.visible_rect(window)
            if rect is not None:
                self.viewable.add(wid)
                self.geometry[wid] = rect
                self.screen.mapped(wid, rect, t)
        elif ev.type == X.UnmapNotify:
            if wid in self.viewable:
                self.viewable.discard(wid)
                self.screen.unmapped(wid, self.geometry.get(wid), t)
        elif ev.type == X.ConfigureNotify:
            rect = clip([ev.x, ev.y, ev.width + 2 * ev.border_width, ev.height + 2 * ev.border_width],
                        self.screen.size)
            before = self.geometry.get(wid)
            # A restack without a move or a resize changes no pixels by itself.
            if before == rect:
                return
            self.geometry[wid] = rect
            if wid in self.viewable:
                for r in (before, rect):
                    if r is not None:
                        self.screen.moved(r, t)
        elif ev.type == X.DestroyNotify:
            self.viewable.discard(wid)
            self.geometry.pop(wid, None)


class Commands:
    pause = staticmethod(time.sleep)

    def __init__(self, screen):
        self.d = display.Display()
        self.root = self.d.screen().root
        self.screen = screen
        self.pings = 0
        self.WM_PROTOCOLS = self.d.intern_atom("WM_PROTOCOLS")
        self.NET_WM_PING = self.d.intern_atom("_NET_WM_PING")
        self.NET_ACTIVE = self.d.intern_atom("_NET_ACTIVE_WINDOW")
        self.NET_STACK = self.d.intern_atom("_NET_CLIENT_LIST_STACKING")
        self.NET_PID = self.d.intern_atom("_NET_WM_PID")
        self.NET_NAME = self.d.intern_atom("_NET_WM_NAME")
        self.NET_EXTENTS = self.d.intern_atom("_NET_FRAME_EXTENTS")
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        info = self.d.display.info
        self.min_kc, self.max_kc = info.min_keycode, info.max_keycode
        self.remapped = {}
        self.d.sync()

    # Events queued on the command connection: MappingNotify after our own keymap changes.
    def drain(self):
        while self.d.pending_events():
            ev = self.d.next_event()
            if ev.type == X.MappingNotify:
                self.d.refresh_keyboard_mapping(ev)

    def prop(self, win, atom):
        p = win.get_full_property(atom, X.AnyPropertyType)
        return None if p is None else p.value

    def active_window(self):
        v = self.prop(self.root, self.NET_ACTIVE)
        return int(v[0]) if v is not None and len(v) else 0

    def window(self, wid):
        return self.d.create_resource_object("window", int(wid))

    def cmd_ping(self, a):
        return {"mono": mono()}

    def cmd_pointer(self, a):
        p = self.root.query_pointer()
        return {"x": p.root_x, "y": p.root_y}

    def cmd_windows(self, a):
        ids = self.prop(self.root, self.NET_STACK)
        active = self.active_window()
        out = []
        for wid in reversed(list(ids or [])):  # EWMH lists bottom to top
            try:
                w = self.window(wid)
                g = w.get_geometry()
                t = self.root.translate_coords(w, 0, 0)
                ext = self.prop(w, self.NET_EXTENTS)
                left, right, top, bottom = (int(v) for v in ext[:4]) if ext is not None and len(ext) >= 4 else (0, 0, 0, 0)
                pid = self.prop(w, self.NET_PID)
                cls = w.get_wm_class()
                name = self.prop(w, self.NET_NAME)
                if isinstance(name, (bytes, bytearray)):
                    title = name.decode("utf-8", "replace")
                else:
                    title = name if isinstance(name, str) else (w.get_wm_name() or "")
                out.append({
                    "id": int(wid),
                    "pid": int(pid[0]) if pid is not None and len(pid) else 0,
                    "cls": cls[1] if cls else "",
                    "title": title,
                    "x": t.x, "y": t.y, "w": g.width, "h": g.height,
                    "frame": [t.x - left, t.y - top, g.width + left + right, g.height + top + bottom],
                    "active": int(wid) == active,
                })
            except Exception:  # noqa: BLE001 - a window that vanished mid-walk
                continue
        return {"windows": out}

    def cmd_activate(self, a):
        wid = int(a["window"])
        before = self.active_window()
        if before == wid:
            return {"active": wid, "changed": False, "waitedMs": 0}
        msg = xevent.ClientMessage(window=self.window(wid), client_type=self.NET_ACTIVE,
                                   data=(32, [2, X.CurrentTime, before, 0, 0]))
        self.root.send_event(msg, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
        self.d.flush()
        t0 = mono()
        deadline = t0 + ACTIVATE_TIMEOUT_MS
        while mono() < deadline:
            if self.d.pending_events() == 0:
                ready, _, _ = select.select([self.d.fileno()], [], [], max(0.0, (deadline - mono()) / 1000))
                if not ready:
                    break
            ev = self.d.next_event()
            if ev.type == X.MappingNotify:
                self.d.refresh_keyboard_mapping(ev)
            elif ev.type == X.PropertyNotify and ev.atom == self.NET_ACTIVE and self.active_window() == wid:
                return {"active": wid, "changed": True, "waitedMs": mono() - t0}
        return {"active": self.active_window(), "changed": False, "waitedMs": mono() - t0, "timedOut": True}

    def cmd_move(self, a):
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        self.d.sync()
        return {"mono": mono()}

    def cmd_click(self, a):
        button = int(a.get("button", 1))
        count = int(a.get("count", 1))
        hold_s = float(a.get("holdMs", 0)) / 1000
        mods = [self.keycode_for_name(m)[0] for m in a.get("mods", [])]
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        for kc in mods:
            self.d.xtest_fake_input(X.KeyPress, kc)
        self.d.sync()
        for i in range(count):
            if i:
                time.sleep(DOUBLE_CLICK_GAP_MS / 1000)
            self.d.xtest_fake_input(X.ButtonPress, button)
            self.d.sync()
            if hold_s:
                time.sleep(hold_s)
            self.d.xtest_fake_input(X.ButtonRelease, button)
            self.d.sync()
        for kc in reversed(mods):
            self.d.xtest_fake_input(X.KeyRelease, kc)
        self.d.sync()
        return {"button": button, "presses": count}

    def cmd_scroll(self, a):
        dx, dy = int(a.get("dx", 0)), int(a.get("dy", 0))
        self.d.xtest_fake_input(X.MotionNotify, x=int(a["x"]), y=int(a["y"]))
        self.d.sync()
        notches = 0
        for button, n in ((5 if dy > 0 else 4, abs(dy)), (7 if dx > 0 else 6, abs(dx))):
            for _ in range(n):
                self.d.xtest_fake_input(X.ButtonPress, button)
                self.d.xtest_fake_input(X.ButtonRelease, button)
                self.d.sync()
                notches += 1
        return {"notches": notches}

    def keysym_for_name(self, name):
        if name in KEYSYMS:
            return KEYSYMS[name]
        if len(name) == 1:
            return keysym_for_char(name)
        raise ValueError("unknown key %r" % name)

    def keycodes_for_keysym(self, keysym):
        codes = list(self.d.keysym_to_keycodes(keysym))
        if codes:
            kc, idx = codes[0]
            return kc, MODS_FOR_INDEX.get(idx, [])
        return self.remap(keysym), []

    def keycode_for_name(self, name):
        return self.keycodes_for_keysym(self.keysym_for_name(name))

    # xdotool's trick for characters the layout lacks: bind a spare keycode to the keysym.
    def remap(self, keysym):
        if keysym in self.remapped:
            return self.remapped[keysym]
        mapping = self.d.get_keyboard_mapping(self.min_kc, self.max_kc - self.min_kc + 1)
        per = len(mapping[0]) if mapping else 1
        spare = None
        for i in range(len(mapping) - 1, -1, -1):
            if all(s == 0 for s in mapping[i]) and (self.min_kc + i) not in self.remapped.values():
                spare = self.min_kc + i
                break
        if spare is None:
            raise RuntimeError("no spare keycode for keysym %#x" % keysym)
        self.d.change_keyboard_mapping(spare, [[keysym] * per])
        self.d.sync()
        self.drain()
        # Every client refreshes its keymap on MappingNotify; a press before the focused app has
        # done so lands as the old (empty) symbol. xdotool waits the same way.
        time.sleep(0.02)
        self.remapped[keysym] = spare
        return spare

    def cmd_char(self, a):
        kc, mods = self.keycodes_for_keysym(keysym_for_char(a["ch"]))
        mod_codes = [self.keycode_for_name(m)[0] for m in mods]
        for m in mod_codes:
            self.d.xtest_fake_input(X.KeyPress, m)
        self.d.xtest_fake_input(X.KeyPress, kc)
        self.d.sync()
        self.d.xtest_fake_input(X.KeyRelease, kc)
        for m in reversed(mod_codes):
            self.d.xtest_fake_input(X.KeyRelease, m)
        self.d.sync()
        return {"keycode": kc, "mods": mods}

    def cmd_keys(self, a):
        codes = [self.keycode_for_name(n)[0] for n in a["combo"]]
        for kc in codes:
            self.d.xtest_fake_input(X.KeyPress, kc)
            self.d.sync()
        for kc in reversed(codes):
            self.d.xtest_fake_input(X.KeyRelease, kc)
        self.d.sync()
        return {"keycodes": codes}

    def cmd_arm(self, a):
        return {"mono": self.screen.arm()}

    def ping(self):
        """Sends _NET_WM_PING to the active window; its token, or None when nothing would answer."""
        try:
            wid = self.active_window()
            if not wid:
                return None
            w = self.window(wid)
            if self.NET_WM_PING not in (w.get_wm_protocols() or []):
                return None
            self.pings += 1
            token = self.pings
            self.screen.expect(token)
            msg = xevent.ClientMessage(window=w, client_type=self.WM_PROTOCOLS,
                                       data=(32, [self.NET_WM_PING, token, wid, 0, 0]))
            w.send_event(msg, event_mask=0)
            self.d.flush()
            return token
        except Exception:  # noqa: BLE001 - a window that vanished just settles without the ping
            return None

    # Returns after `quietMs` without a change, or after `firstMs` when nothing changed at all,
    # but never while a window mapped since arm has not painted, nor before the pinged app has
    # answered and then had `quietMs` to draw what it did.
    def cmd_settle(self, a):
        quiet = float(a.get("quietMs", 250))
        first = float(a.get("firstMs", 1500))
        timeout = float(a.get("timeoutMs", 3000))
        t0 = self.screen.clock()
        token = self.ping() if a.get("verb") in PING_VERBS else None
        while True:
            s = self.screen.snapshot(token)
            now = self.screen.clock()
            if now - t0 >= timeout:
                return {"changed": merge_rects(s.rects), "lastChange": s.last, "quiet": False,
                        "noVisibleChange": s.count == 0}
            busy = s.unpainted or (token is not None and (s.pong is None or now - s.pong < quiet))
            if not busy and s.count and now - s.last >= quiet:
                return {"changed": merge_rects(s.rects), "lastChange": s.last, "quiet": True,
                        "noVisibleChange": False}
            if not busy and not s.count and now - t0 >= first:
                return {"changed": [], "lastChange": None, "quiet": True, "noVisibleChange": True}
            self.pause(0.01)



def main():
    screen = Screen()
    listener = Listener(screen)
    listener.start()
    listener.ready.wait(5)
    if listener.error:
        sys.exit(1)
    cmds = Commands(screen)
    emit({"ev": "ready", "mono": mono()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "quit":
                emit({"id": rid, "ok": True})
                break
            fn = getattr(cmds, "cmd_" + str(cmd), None)
            if fn is None:
                emit({"id": rid, "ok": False, "error": "unknown command %r" % cmd})
                continue
            cmds.drain()
            res = fn(req)
            res["id"] = rid
            res["ok"] = True
            emit(res)
        except Exception as err:  # noqa: BLE001 - every failure is reported on the reply line
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(err).__name__, err)})


if __name__ == "__main__":
    main()
