#!/usr/bin/python3
"""localDot desktopd accessibility helper: the element under a point, keyboard focus and window
trees, over AT-SPI. It runs apart from xhelper, so a hung application never blocks input or its raw
timestamps, and it stays up, so the AT-SPI cache and the focus events it has seen carry over.

JSON lines over stdio, like xhelper:
  request  {"id": 1, "cmd": "at", "deadline": 12345.6, ...} -> {"id": 1, "ok": true, ...}
  event    {"ev": "ready", "mono": 12345.678}
`deadline` is CLOCK_MONOTONIC milliseconds, the clock desktopd reads. A query that reaches it
answers {"unknown": true}, never a partial result; only a tree comes back cut short, marked
truncated. Only roles, names, states and extents are read, never a control's text or value.

Coordinates: desktopd sends device pixels and the window's client origin. GTK reports frame units,
device = origin + (frame - floor(origin / g)) * g; Chromium's own UI reports device / c. LibreOffice
draws most of its window itself (VCL) and, for a while after a window opens, reports those parts one
native menu bar too high, while the GTK widgets inside its tool bars report true positions. Frames go
back corrected to true frame units.
"""
import collections
import json
import math
import os
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

# A hung application costs at most this per call; the deadline is checked between calls.
CALL_TIMEOUT_MS = 150
# Containers with more children are not scanned or walked: a spreadsheet table exposes billions.
SCAN_LIMIT = 256
WALK_CHILD_LIMIT = 1000
DEPTH_LIMIT = 40
TREE_LIMIT = 3000
# Frame units between a window's X frame and its top-level accessible's extents: an untitled
# accessible must match the frame, a titled one may differ by a client-side shadow.
MATCH_SLACK = 4
TITLED_SLACK = 64
RECENT_LIMIT = 16
# A focus walk that ran out of time goes on between requests, this long at a time, and is started
# afresh once this old.
SLICE_MS = 20
WALK_MAX_AGE_MS = 3000
MENU_ROLES = ("menu", "menu item", "check menu item", "radio menu item")
# GTK widgets LibreOffice embeds in its own (VCL) window report true positions.
GTK_DRAWN_ROLES = frozenset((
    "text", "entry", "password text", "menu", "menu bar", "menu item", "check menu item",
    "radio menu item", "scroll bar", "combo box",
))
SHOWING = Atspi.StateType.SHOWING


def mono():
    return time.monotonic_ns() / 1e6


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Expired(Exception):
    """The request's deadline passed."""


def extents(node):
    comp = node.get_component_iface()
    if comp is None:
        return None
    e = comp.get_extents(Atspi.CoordType.SCREEN)
    if e.width <= 0 or e.height <= 0 or e.x <= -10000 or e.y <= -10000:
        return None
    return (e.x, e.y, e.width, e.height)


def inside(r, x, y):
    return r[0] <= x < r[0] + r[2] and r[1] <= y < r[1] + r[3]


def showing(node):
    return node.get_state_set().contains(SHOWING)


def has(node, state):
    return node.get_state_set().contains(state)


class Query:
    """One request: its window, its coordinate space and its deadline."""

    def __init__(self, req, clock=mono):
        self.clock = clock
        self.deadline = float(req.get("deadline") or clock() + 300)
        win = req.get("window") or {}
        self.pid = int(win.get("pid") or 0)
        self.title = win.get("title") or ""
        self.rect = list(win.get("rect") or [0, 0, 0, 0])
        self.frame = list(win.get("frame") or self.rect)
        self.popup = bool(win.get("overrideRedirect"))
        self.parent = req.get("parent")
        self.kit = req.get("kit") or "gtk"
        self.g = float(req.get("g") or 1)
        self.c = float(req.get("c") or 1)
        # LibreOffice's VCL offset in frame units, read off its root pane.
        self.shift = 0

    def check(self):
        if self.clock() >= self.deadline:
            raise Expired()

    def to_frame(self, x, y):
        if self.kit == "chromium":
            return (x / self.c, y / self.c)
        ox, oy = self.rect[0], self.rect[1]
        return (math.floor(ox / self.g) + (x - ox) / self.g,
                math.floor(oy / self.g) + (y - oy) / self.g)

    def frame_rect(self, r):
        x0, y0 = self.to_frame(r[0], r[1])
        x1, y1 = self.to_frame(r[0] + r[2], r[1] + r[3])
        return (x0, y0, x1 - x0, y1 - y0)

    def space(self):
        return "chrome" if self.kit == "chromium" else "gtk"


class FocusWalk:
    """A window's walk for its focused accessible, which can stop at a deadline and go on later."""

    def __init__(self, root, now):
        self.stack = [(root, [])]
        self.best = None
        self.visited = 0
        self.started = now

    def run(self, check):
        while self.stack and self.visited < TREE_LIMIT:
            check()
            node, path = self.stack.pop()
            self.visited += 1
            try:
                ss = node.get_state_set()
                if path and not ss.contains(SHOWING):
                    continue
                if ss.contains(Atspi.StateType.FOCUSED) and (
                        self.best is None or len(path) > len(self.best[1])):
                    self.best = (node, path)
                count = node.get_child_count()
                if node.get_role_name() in ("table", "tree table") or count > WALK_CHILD_LIMIT:
                    continue
                for i in range(count - 1, -1, -1):
                    c = node.get_child_at_index(i)
                    if c is not None:
                        self.stack.append((c, [node] + path))
            except Exception:  # noqa: BLE001 - an accessible that vanished mid-walk
                continue
        return self.best


class Helper:
    def __init__(self, desktop=None, idle=None):
        self.desktop = desktop
        self.idle = idle or GLib.idle_add
        self.apps = {}
        # Newest first: accessibles whose focus or selection AT-SPI announced.
        self.focus = collections.deque(maxlen=RECENT_LIMIT)
        self.menus = collections.deque(maxlen=RECENT_LIMIT)
        # Focus walks by top-level accessible: unfinished ones, and the answers of finished ones.
        self.walks = {}
        self.walked = {}
        self.walking = False

    def on_event(self, ev):
        try:
            src = ev.source
            if src is None:
                return
            if ev.type.startswith("object:state-changed:focused"):
                if src in self.focus:
                    self.focus.remove(src)
                if ev.detail1:
                    self.focus.appendleft(src)
            role = src.get_role_name() if ev.detail1 else None
            if role in MENU_ROLES:
                menu = src if role == "menu" else src.get_parent()
                if menu is not None:
                    if menu in self.menus:
                        self.menus.remove(menu)
                    self.menus.appendleft(menu)
        except Exception:  # noqa: BLE001 - an accessible that vanished while its event was queued
            return

    def app(self, pid, q):
        app = self.apps.get(pid)
        if app is not None:
            try:
                if app.get_process_id() == pid:
                    return app
            except Exception:  # noqa: BLE001 - the application exited
                pass
        desktop = self.desktop or Atspi.get_desktop(0)
        self.apps = {}
        for i in range(desktop.get_child_count()):
            q.check()
            try:
                a = desktop.get_child_at_index(i)
                if a is not None:
                    self.apps.setdefault(a.get_process_id(), a)
            except Exception:  # noqa: BLE001
                continue
        return self.apps.get(pid)

    def root(self, app, q, title, frame):
        """The app's top-level accessible for an X window: by its title and place, else by its
        place alone. The place keeps a window that copies another's title and process id from
        lending it that window's elements."""
        want = q.frame_rect(frame)
        best = None
        for i in range(min(app.get_child_count(), 100)):
            q.check()
            try:
                node = app.get_child_at_index(i)
                if node is None or not showing(node):
                    continue
                ext = extents(node)
                if ext is None:
                    continue
                named = bool(title) and (node.get_name() or "") == title
                off = max(abs(ext[k] - want[k]) for k in range(4))
                if off > (TITLED_SLACK if named else MATCH_SLACK):
                    continue
                key = (not named, off)
                if best is None or key < best[0]:
                    best = (key, node)
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        return best[1] if best else None

    def placed(self, child, parent, shifts, q, x, y):
        """The VCL shift under which `child` is showing at (x, y), or None."""
        # Chromium's web content belongs to CDP; its accessible reports device pixels.
        if child.get_role_name() == "document web" or not showing(child):
            return None
        ext = extents(child)
        if ext is None:
            return None
        if q.kit == "libreoffice" and child.get_role_name() == "root pane":
            host = extents(parent)
            if host and ext[1] < host[1] and abs(ext[3] - host[3]) <= 1:
                q.shift = host[1] - ext[1]
            return q.shift if inside(ext, x, y - q.shift) else None
        for s in shifts:
            if inside(ext, x, y - s):
                return s
        return None

    def child_at(self, node, shift, q, x, y):
        shifts = (shift, q.shift - shift) if q.shift else (shift,)
        comp = node.get_component_iface()
        if comp is not None:
            child = comp.get_accessible_at_point(math.floor(x), math.floor(y - shift),
                                                 Atspi.CoordType.SCREEN)
            if child is not None and child != node:
                s = self.placed(child, node, shifts, q, x, y)
                if s is not None:
                    return child, s
        # Some toolkits (Chromium's UI) answer point queries poorly: look at the children.
        count = node.get_child_count()
        if count <= 0 or count > SCAN_LIMIT:
            return None
        best = None
        tabs = node.get_role_name() == "page tab list"
        selected = None
        for i in range(count):
            q.check()
            try:
                c = node.get_child_at_index(i)
                if c is None:
                    continue
                if tabs and c.get_role_name() == "page tab" and has(c, Atspi.StateType.SELECTED):
                    selected = c
                s = self.placed(c, node, shifts, q, x, y)
                if s is None:
                    continue
                ext = extents(c)
                if best is None or ext[2] * ext[3] <= best[0]:
                    best = (ext[2] * ext[3], c, s)
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        if best:
            return best[1], best[2]
        # A notebook's page tab spans only its label, while the page it holds fills the notebook:
        # off the labels, the selected tab leads to what the point is on.
        return (selected, shift) if selected is not None else None

    def descend(self, root, q, x, y):
        """The deepest element under the point. Stepping through a notebook's selected tab can
        end on the tab itself, off the point: the deepest element that held the point stands."""
        node, shift, path = root, 0, []
        held = (root, 0, [])
        while len(path) < DEPTH_LIMIT:
            q.check()
            try:
                step = self.child_at(node, shift, q, x, y)
            except Expired:
                raise
            except Exception:  # noqa: BLE001 - keep the deepest element that answered
                step = None
            if step is None:
                break
            path = path + [node]
            node, shift = step
            ext = extents(node)
            if ext is not None and inside(ext, x, y - shift):
                held = (node, shift, path)
        return held

    def in_menu(self, menu, q, x, y, path, depth=0):
        """The showing item of an open menu (or of its open submenus) under the point."""
        count = menu.get_child_count()
        if count <= 0 or count > SCAN_LIMIT or depth > 4:
            return None
        for i in range(count):
            q.check()
            c = menu.get_child_at_index(i)
            if c is None or not showing(c):
                continue
            ext = extents(c)
            if ext is not None and inside(ext, x, y):
                return c, 0, path + [menu]
            if c.get_role_name() == "menu" and has(c, Atspi.StateType.SELECTED):
                found = self.in_menu(c, q, x, y, path + [menu], depth + 1)
                if found:
                    return found
        return None

    def open_menus(self, q):
        """The menus AT-SPI announced as opened, then the selected ones in the parent's menu bar."""
        for menu in list(self.menus):
            yield menu
        parent = q.parent or {}
        app = self.app(int(parent.get("pid") or 0), q) if parent else None
        root = self.root(app, q, parent.get("title") or "", parent.get("frame") or q.frame) if app else None
        stack = [(root, 0)] if root is not None else []
        while stack:
            q.check()
            node, depth = stack.pop()
            if node.get_role_name() == "menu bar":
                for i in range(min(node.get_child_count(), SCAN_LIMIT)):
                    m = node.get_child_at_index(i)
                    if m is not None and has(m, Atspi.StateType.SELECTED):
                        yield m
                continue
            if depth >= 6 or not showing(node):
                continue
            for i in range(min(node.get_child_count(), 64)):
                c = node.get_child_at_index(i)
                if c is not None:
                    stack.append((c, depth + 1))

    def popup_item(self, q, x, y):
        for menu in self.open_menus(q):
            q.check()
            try:
                if menu.get_process_id() != q.pid or not showing(menu):
                    continue
                found = self.in_menu(menu, q, x, y, [])
                if found:
                    return found
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        return None

    def cmd_at(self, req):
        q = Query(req)
        point = req.get("point") or {}
        x, y = q.to_frame(float(point.get("x", 0)), float(point.get("y", 0)))
        app = self.app(q.pid, q)
        if app is None:
            return {"element": None}
        root = self.root(app, q, q.title, q.frame)
        if root is None:
            # A GTK menu has no top-level accessible: it hangs off its menu bar or its widget.
            found = self.popup_item(q, x, y) if q.popup else None
            return {"element": self.describe(*found, q) if found else None}
        node, shift, path = self.descend(root, q, x, y)
        return {"element": self.describe(node, shift, path, q)}

    def ancestors(self, node, q):
        """The parents of `node` up to its top-level accessible, nearest first."""
        out = []
        p = node.get_parent()
        while p is not None and len(out) < 64:
            q.check()
            if p.get_role_name() == "application":
                return out
            out.append(p)
            p = p.get_parent()
        return None

    def vcl_shift(self, node, path, q):
        """The VCL shift of a LibreOffice element found without a point (`path` nearest first)."""
        if q.kit != "libreoffice":
            return 0
        chain = [node] + path
        roles = [n.get_role_name() for n in chain]
        if "root pane" not in roles:
            return 0
        i = roles.index("root pane")
        if i + 1 < len(chain):
            pane, host = extents(chain[i]), extents(chain[i + 1])
            if pane and host and pane[1] < host[1] and abs(pane[3] - host[3]) <= 1:
                q.shift = host[1] - pane[1]
        if any(r in GTK_DRAWN_ROLES for r in roles[:i]):
            return 0
        return q.shift

    def focused_from_events(self, root, q):
        best = None
        for node in list(self.focus):
            q.check()
            try:
                if node.get_process_id() != q.pid:
                    continue
                if not (has(node, Atspi.StateType.FOCUSED) and showing(node)):
                    continue
                path = self.ancestors(node, q)
                if not path:
                    continue
                top = path[-1]
                # A combo box's popup list is its own top-level while the window keeps focus.
                if top != root and not (top.get_role_name() == "window" and not top.get_name()):
                    continue
                if best is None or len(path) > len(best[1]):
                    best = (node, path)
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        return best

    def focused_walked(self, root):
        """A finished walk's answer while it still has focus."""
        found = self.walked.get(root)
        if found is None:
            return None
        try:
            if has(found[0], Atspi.StateType.FOCUSED) and showing(found[0]):
                return found
        except Exception:  # noqa: BLE001
            pass
        del self.walked[root]
        return None

    def focused_by_walk(self, root, q):
        """Without a focus event (the focus predates the helper), a walk finds it. One that runs
        out of time answers unknown and goes on between requests, for the next query to use."""
        walk = self.walks.get(root)
        if walk is None or q.clock() - walk.started > WALK_MAX_AGE_MS:
            walk = self.walks[root] = FocusWalk(root, q.clock())
        try:
            found = walk.run(q.check)
        except Expired:
            if not self.walking:
                self.walking = True
                self.idle(self.continue_walks)
            raise
        self.finish(root, found)
        return found

    def finish(self, root, found):
        self.walks.pop(root, None)
        if len(self.walked) >= RECENT_LIMIT:
            self.walked.clear()
        if found is not None:
            self.walked[root] = found

    def continue_walks(self):
        """One slice of every unfinished focus walk; True while any remains."""
        now = mono()
        for root, walk in list(self.walks.items()):
            if now - walk.started > WALK_MAX_AGE_MS:
                del self.walks[root]
                continue
            q = Query({"deadline": now + SLICE_MS})
            try:
                self.finish(root, walk.run(q.check))
            except Expired:
                return True
        self.walking = False
        return False

    def cmd_focused(self, req):
        q = Query(req)
        app = self.app(q.pid, q)
        root = self.root(app, q, q.title, q.frame) if app is not None else None
        if root is None:
            return {"element": None}
        found = (self.focused_from_events(root, q) or self.focused_walked(root)
                 or self.focused_by_walk(root, q))
        if found is None:
            return {"element": None}
        node, path = found
        shift = self.vcl_shift(node, path, q)
        return {"element": self.describe(node, shift, list(reversed(path)), q)}

    def showing_in(self, root, q):
        """The window's showing accessibles in one application-side query, where its toolkit
        answers one; None otherwise. LibreOffice's would count a spreadsheet's every cell."""
        if q.kit == "libreoffice":
            return None
        try:
            coll = root.get_collection_iface()
            if coll is None:
                return None
            rule = Atspi.MatchRule.new(
                Atspi.StateSet.new([SHOWING]), Atspi.CollectionMatchType.ALL, None,
                Atspi.CollectionMatchType.ALL, [], Atspi.CollectionMatchType.ALL, [],
                Atspi.CollectionMatchType.ALL, False)
            return coll.get_matches(rule, Atspi.CollectionSortOrder.CANONICAL, TREE_LIMIT, True)
        except Exception:  # noqa: BLE001 - the walk below works for every toolkit
            return None

    def cmd_tree(self, req):
        """A window's named elements. A walk its deadline cuts short still answers what it found,
        marked truncated (never cached): find can match the parts it reached first, and the
        element it names is looked up again before any input."""
        q = Query(req)
        app = self.app(q.pid, q)
        root = self.root(app, q, q.title, q.frame) if app is not None else None
        if root is None:
            return {"elements": [], "truncated": False}
        elements = []
        try:
            return {"elements": elements, "truncated": self.named(root, q, elements)}
        except Expired:
            return {"elements": elements, "truncated": True}

    def named(self, root, q, elements):
        """Appends the window's named elements; True if some were left out."""
        matches = self.showing_in(root, q)
        if matches is not None:
            for node in matches:
                q.check()
                try:
                    role = node.get_role_name() or ""
                    if role == "document web":
                        continue
                    name = node.get_name() or ""
                    el = self.describe(node, 0, [], q, role, name) if name else None
                    if el is not None:
                        elements.append(el)
                except Exception:  # noqa: BLE001
                    continue
            return len(matches) >= TREE_LIMIT
        stack = [(root, [])]
        visited = 0
        while stack and visited < TREE_LIMIT:
            q.check()
            node, path = stack.pop()
            visited += 1
            try:
                if path and not showing(node):
                    continue
                role = node.get_role_name() or ""
                top_down = list(reversed(path))
                name = self.name_of(node, role, top_down, q)
                el = self.describe(node, self.vcl_shift(node, path, q), top_down, q, role, name) if name else None
                if el is not None:
                    elements.append(el)
                count = node.get_child_count()
                if role in ("table", "document web") or count > WALK_CHILD_LIMIT:
                    continue
                for i in range(count - 1, -1, -1):
                    c = node.get_child_at_index(i)
                    if c is not None:
                        stack.append((c, [node] + path))
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        return bool(stack)

    # Chromium's web content area, which its accessible reports in device pixels (CDP's origin).
    def cmd_content(self, req):
        q = Query(req)
        app = self.app(q.pid, q)
        root = self.root(app, q, q.title, q.frame) if app is not None else None
        stack = [(root, 0)] if root is not None else []
        while stack:
            q.check()
            node, depth = stack.pop()
            try:
                if node.get_role_name() == "document web" and showing(node):
                    ext = extents(node)
                    if ext is not None:
                        return {"frame": {"x": ext[0], "y": ext[1], "w": ext[2], "h": ext[3]}}
                if depth >= 28:
                    continue
                for i in range(min(node.get_child_count(), 200) - 1, -1, -1):
                    c = node.get_child_at_index(i)
                    if c is not None:
                        stack.append((c, depth + 1))
            except Expired:
                raise
            except Exception:  # noqa: BLE001
                continue
        return {"frame": None}

    def name_of(self, node, role, path, q):
        name = node.get_name() or ""
        if not name and q.kit == "libreoffice" and role == "text" and self.is_name_box(path):
            return "Name Box"
        return name

    def describe(self, node, shift, path, q, role=None, name=None):
        """`path` runs from the top-level accessible down to the node's parent."""
        ext = extents(node)
        if ext is None:
            return None
        role = role if role is not None else node.get_role_name() or ""
        name = name if name is not None else self.name_of(node, role, path, q)
        return {
            "role": role[:64],
            "name": name[:256],
            "frame": {"x": ext[0], "y": ext[1] + shift, "w": ext[2], "h": ext[3]},
            "space": q.space(),
            "secret": role == "password text",
            "editable": has(node, Atspi.StateType.EDITABLE),
        }

    # Calc's cell reference box has no accessible name: it is the text of a combo box inside the
    # Formula Tool Bar.
    @staticmethod
    def is_name_box(path):
        if not path or path[-1].get_role_name() != "combo box":
            return False
        return any(p.get_role_name() == "tool bar" and p.get_name() == "Formula Tool Bar"
                   for p in path)

    def handle(self, line):
        """Answers one request line; False after `quit`."""
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "quit":
                emit({"id": rid, "ok": True})
                return False
            fn = getattr(self, "cmd_" + str(cmd), None)
            if fn is None:
                emit({"id": rid, "ok": False, "error": "unknown command %r" % cmd})
                return True
            try:
                res = fn(req)
            except (Expired, GLib.Error):
                # A call the application did not answer in time leaves the element unknown.
                res = {"unknown": True}
            res["id"] = rid
            res["ok"] = True
            emit(res)
        except Exception as err:  # noqa: BLE001 - every failure is reported on the reply line
            emit({"id": rid, "ok": False, "error": "%s: %s" % (type(err).__name__, err)})
        return True


def main():
    Atspi.set_timeout(CALL_TIMEOUT_MS, -1)
    helper = Helper()
    listener = Atspi.EventListener.new(helper.on_event)
    for event in ("object:state-changed:focused", "object:state-changed:selected"):
        listener.register(event)
    loop = GLib.MainLoop()
    pending = bytearray()

    def on_input(fd, condition):
        chunk = os.read(fd, 65536) if condition & GLib.IO_IN else b""
        if not chunk:
            loop.quit()
            return False
        pending.extend(chunk)
        while b"\n" in pending:
            i = pending.index(b"\n")
            line = bytes(pending[:i]).strip()
            del pending[:i + 1]
            if line and not helper.handle(line):
                loop.quit()
                return False
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_input)
    emit({"ev": "ready", "mono": mono()})
    loop.run()


if __name__ == "__main__":
    main()
