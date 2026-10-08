"""localDot desktopd X helper: XTest injection, window activation, XI2 raw-press stamps, settle
(DAMAGE, window changes, app pings) and root capture.

Runs as the desktop user with DISPLAY set. JSON lines over stdio:
  request  {"id": 1, "cmd": "click", ...} -> {"id": 1, "ok": true, ...} | {"id": 1, "ok": false, "error": "..."}
  event    {"ev": "press"|"release", "kind": "button"|"key", "detail": 1, "mono": 12345.678}
Times are CLOCK_MONOTONIC milliseconds (time.monotonic_ns() / 1e6), the clock desktopd's Node
process reads through process.hrtime, so nothing inside the cell needs a clock mapping.
X connections: `cmd` serves requests on the main thread, `evt` feeds the listener thread, and
`capture` opens an Xlib one for MIT-SHM on first use.
"""
import collections
import ctypes
import json
import os
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
        # Counts every damage and window change, ambient or not: a cache keyed by it is valid only
        # while nothing on the screen has changed.
        self.generation = 0

    def _change(self, rect, t):
        if rect is not None:
            self.rects.append(rect)
            if len(self.rects) > 256:
                self.rects = merge_rects(self.rects)
        self.last = t
        self.count += 1

    def add(self, rect, t):
        with self.lock:
            self.generation += 1
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
            self.generation += 1
            self._change(rect, t)
            self.unpainted[wid] = (rect, t)

    def unmapped(self, wid, rect, t):
        with self.lock:
            self.generation += 1
            self._change(rect, t)
            self.unpainted.pop(wid, None)

    def moved(self, rect, t):
        with self.lock:
            self.generation += 1
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


class RootShm:
    """The root window through MIT-SHM: the server copies its pixels into a shared segment."""

    class Segment(ctypes.Structure):
        _fields_ = [("shmseg", ctypes.c_ulong), ("shmid", ctypes.c_int),
                    ("shmaddr", ctypes.c_void_p), ("readOnly", ctypes.c_int)]

    class Image(ctypes.Structure):
        _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
                    ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
                    ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int),
                    ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                    ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
                    ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong),
                    ("blue_mask", ctypes.c_ulong)]

    class Error(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("resourceid", ctypes.c_ulong), ("serial", ctypes.c_ulong),
                    ("error_code", ctypes.c_ubyte), ("request_code", ctypes.c_ubyte),
                    ("minor_code", ctypes.c_ubyte)]

    def __init__(self):
        x11 = ctypes.CDLL("libX11.so.6")
        xext = ctypes.CDLL("libXext.so.6")
        libc = ctypes.CDLL(None, use_errno=True)
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
        x11.XDefaultVisual.restype = ctypes.c_void_p
        x11.XDefaultVisual.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XFree.argtypes = [ctypes.c_void_p]
        xext.XShmQueryExtension.argtypes = [ctypes.c_void_p]
        xext.XShmCreateImage.restype = ctypes.POINTER(RootShm.Image)
        xext.XShmCreateImage.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_int,
                                         ctypes.c_char_p, ctypes.POINTER(RootShm.Segment),
                                         ctypes.c_uint, ctypes.c_uint]
        xext.XShmAttach.argtypes = [ctypes.c_void_p, ctypes.POINTER(RootShm.Segment)]
        xext.XShmDetach.argtypes = [ctypes.c_void_p, ctypes.POINTER(RootShm.Segment)]
        xext.XShmGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(RootShm.Image),
                                      ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        libc.shmget.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.c_int]
        libc.shmat.restype = ctypes.c_void_p
        libc.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        libc.shmdt.argtypes = [ctypes.c_void_p]
        libc.shmctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.x11, self.xext, self.libc = x11, xext, libc
        self.errors = []

        # Xlib's default error handler ends the process; record the error and fail the capture.
        def on_error(_dpy, err):
            self.errors.append(err.contents.error_code)
            return 0
        self.on_error = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(RootShm.Error))(on_error)
        x11.XSetErrorHandler(self.on_error)
        self.dpy = x11.XOpenDisplay(None)
        if not self.dpy:
            raise RuntimeError("capture: cannot open the display")
        if not xext.XShmQueryExtension(self.dpy):
            raise RuntimeError("capture: the server has no MIT-SHM")
        self.root = x11.XDefaultRootWindow(self.dpy)
        self.visual = x11.XDefaultVisual(self.dpy, x11.XDefaultScreen(self.dpy))
        self.segment = RootShm.Segment()
        self.image = None
        self.size = None

    def _free(self, image):
        image.contents.data = None
        self.x11.XFree(image)

    def _release(self):
        if self.image is None:
            return
        self.xext.XShmDetach(self.dpy, ctypes.byref(self.segment))
        self.x11.XSync(self.dpy, 0)
        self.libc.shmdt(self.segment.shmaddr)
        self._free(self.image)
        self.image = None
        self.size = None

    def _create(self, width, height):
        self._release()
        image = self.xext.XShmCreateImage(self.dpy, self.visual, 24, X.ZPixmap, None,
                                          ctypes.byref(self.segment), width, height)
        if not image:
            raise RuntimeError("capture: XShmCreateImage failed")
        im = image.contents
        if (im.bits_per_pixel != 32 or im.byte_order != X.LSBFirst
                or (im.red_mask, im.green_mask, im.blue_mask) != (0xFF0000, 0xFF00, 0xFF)):
            self._free(image)
            raise RuntimeError("capture: unsupported pixel format")
        shmid = self.libc.shmget(0, im.bytes_per_line * height, 0o1600)
        if shmid < 0:
            self._free(image)
            raise RuntimeError("capture: shmget failed (errno %d)" % ctypes.get_errno())
        addr = self.libc.shmat(shmid, None, 0)
        if addr in (None, ctypes.c_void_p(-1).value):
            self.libc.shmctl(shmid, 0, None)
            self._free(image)
            raise RuntimeError("capture: shmat failed (errno %d)" % ctypes.get_errno())
        self.segment.shmid = shmid
        self.segment.shmaddr = addr
        self.segment.readOnly = 0
        im.data = addr
        self.errors.clear()
        attached = self.xext.XShmAttach(self.dpy, ctypes.byref(self.segment))
        self.x11.XSync(self.dpy, 0)
        # IPC_RMID at once: the segment goes when both the server and this process detach.
        self.libc.shmctl(shmid, 0, None)
        if not attached or self.errors:
            self.libc.shmdt(addr)
            self._free(image)
            raise RuntimeError("capture: XShmAttach failed")
        self.image = image
        self.size = (width, height)

    def grab(self, width, height):
        """The root's BGRX pixels in the shared segment (valid until the next grab) and their stride."""
        if self.size != (width, height):
            self._create(width, height)
        self.errors.clear()
        ok = self.xext.XShmGetImage(self.dpy, self.root, self.image, 0, 0, ctypes.c_ulong(-1).value)
        if not ok or self.errors:
            raise RuntimeError("capture: XShmGetImage failed")
        stride = self.image.contents.bytes_per_line
        return (ctypes.c_char * (stride * height)).from_address(self.segment.shmaddr), stride


class Commands:
    pause = staticmethod(time.sleep)

    def __init__(self, screen):
        self.d = display.Display()
        self.root = self.d.screen().root
        self.screen = screen
        self.shm = None
        self.pings = 0
        self.WM_PROTOCOLS = self.d.intern_atom("WM_PROTOCOLS")
        self.NET_WM_PING = self.d.intern_atom("_NET_WM_PING")
        self.NET_ACTIVE = self.d.intern_atom("_NET_ACTIVE_WINDOW")
        self.NET_STACK = self.d.intern_atom("_NET_CLIENT_LIST_STACKING")
        self.NET_PID = self.d.intern_atom("_NET_WM_PID")
        self.NET_NAME = self.d.intern_atom("_NET_WM_NAME")
        self.NET_EXTENTS = self.d.intern_atom("_NET_FRAME_EXTENTS")
        self.TRANSIENT_FOR = self.d.intern_atom("WM_TRANSIENT_FOR")
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

    def root_child(self, wid):
        """The root's child that holds a client window: its window manager frame, or itself."""
        w = self.window(wid)
        for _ in range(8):
            parent = w.query_tree().parent
            if parent is None or parent.id in (0, self.root.id):
                return w.id
            w = parent
        return w.id

    def describe(self, wid, active, popup=False, stack=False):
        w = self.window(wid)
        g = w.get_geometry()
        t = self.root.translate_coords(w, 0, 0)
        ext = None if popup else self.prop(w, self.NET_EXTENTS)
        left, right, top, bottom = (int(v) for v in ext[:4]) if ext is not None and len(ext) >= 4 else (0, 0, 0, 0)
        pid = self.prop(w, self.NET_PID)
        cls = w.get_wm_class()
        name = self.prop(w, self.NET_NAME)
        if isinstance(name, (bytes, bytearray)):
            title = name.decode("utf-8", "replace")
        else:
            title = name if isinstance(name, str) else (w.get_wm_name() or "")
        info = {
            "id": int(wid),
            "pid": int(pid[0]) if pid is not None and len(pid) else 0,
            "cls": cls[1] if cls else "",
            "title": title,
            "x": t.x, "y": t.y, "w": g.width, "h": g.height,
            "frame": [t.x - left, t.y - top, g.width + left + right, g.height + top + bottom],
            "active": int(wid) == active,
        }
        if stack:
            parent = self.prop(w, self.TRANSIENT_FOR)
            info["overrideRedirect"] = popup
            info["transientFor"] = int(parent[0]) if parent is not None and len(parent) and int(parent[0]) else None
        return info

    # Managed windows, top first. With `stack`, the mapped override-redirect windows (menus,
    # popups, tooltips) join them in their stacking place, every window names its transient
    # parent, and the reply carries the screen's change generation.
    def cmd_windows(self, a):
        ids = [int(wid) for wid in (self.prop(self.root, self.NET_STACK) or [])]
        active = self.active_window()
        if not a.get("stack"):
            entries = [(0, i, wid, False) for i, wid in enumerate(ids)]
        else:
            children = self.root.query_tree().children
            place = {w.id: i for i, w in enumerate(children)}
            managed = set(ids)
            entries = []
            for i, wid in enumerate(ids):
                try:
                    entries.append((place.get(self.root_child(wid), -1), i, wid, False))
                except Exception:  # noqa: BLE001 - a window that vanished mid-walk
                    continue
            for w in children:
                if w.id in managed:
                    continue
                try:
                    attrs = w.get_attributes()
                except Exception:  # noqa: BLE001
                    continue
                if attrs.override_redirect and attrs.map_state == X.IsViewable and attrs.win_class != X.InputOnly:
                    entries.append((place[w.id], 0, w.id, True))
        out = []
        for _, _, wid, popup in sorted(entries, reverse=True):
            try:
                info = self.describe(wid, active, popup, bool(a.get("stack")))
            except Exception:  # noqa: BLE001 - a window that vanished mid-walk
                continue
            if popup:
                rect = clip(info["frame"], self.screen.size)
                if rect is None:
                    continue
                if not info["pid"] and info["transientFor"]:
                    try:
                        parent = self.prop(self.window(info["transientFor"]), self.NET_PID)
                        info["pid"] = int(parent[0]) if parent is not None and len(parent) else 0
                    except Exception:  # noqa: BLE001
                        pass
            out.append(info)
        if not a.get("stack"):
            return {"windows": out}
        return {"windows": out, "generation": self.screen.generation}

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

    def grab(self, width, height):
        if self.shm is None:
            try:
                self.shm = RootShm()
            except Exception as err:  # noqa: BLE001 - the protocol path below still works
                sys.stderr.write("capture: MIT-SHM unavailable, using GetImage (%s)\n" % err)
                self.shm = False
        if self.shm:
            return self.shm.grab(width, height)
        info = self.d.display.info
        visual = self.d.screen().root_visual
        formats = [f for f in info.pixmap_formats if f.depth == 24]
        masks = [(v.red_mask, v.green_mask, v.blue_mask) for depth in self.d.screen().allowed_depths
                 for v in depth.visuals if v.visual_id == visual]
        if (len(formats) != 1 or formats[0].bits_per_pixel != 32 or info.image_byte_order != X.LSBFirst
                or masks != [(0xFF0000, 0xFF00, 0xFF)]):
            raise RuntimeError("capture: unsupported pixel format")
        image = self.root.get_image(0, 0, width, height, X.ZPixmap, 0xFFFFFFFF)
        if len(image.data) != width * height * 4:
            raise RuntimeError("capture: unexpected image size")
        return image.data, width * 4

    # The whole root as BGRX rows at device resolution, written in place into `path` (a tmpfs file
    # desktopd reads); reusing the file keeps its pages, so the write is one copy.
    def cmd_capture(self, a):
        g = self.root.get_geometry()
        t = mono()
        pixels, stride = self.grab(g.width, g.height)
        view = memoryview(pixels).cast("B")
        fd = os.open(a["path"], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            if os.fstat(fd).st_size != len(view):
                os.ftruncate(fd, len(view))
            done = 0
            while done < len(view):
                done += os.pwrite(fd, view[done:], done)
        finally:
            os.close(fd)
        return {"width": g.width, "height": g.height, "stride": stride, "mono": t}


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
