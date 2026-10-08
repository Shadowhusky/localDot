import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


# The parts of AT-SPI the helper uses; PyGObject itself is only in the desktop image.
class StateType:
    SHOWING, FOCUSED, SELECTED, EDITABLE = "showing", "focused", "selected", "editable"


class GError(Exception):
    pass


Atspi = types.SimpleNamespace(
    StateType=StateType,
    CoordType=types.SimpleNamespace(SCREEN="screen"),
    MatchRule=types.SimpleNamespace(new=lambda *rule: rule),
    StateSet=types.SimpleNamespace(new=lambda states: states),
    CollectionMatchType=types.SimpleNamespace(ALL="all"),
    CollectionSortOrder=types.SimpleNamespace(CANONICAL="canonical"),
)
GLib = types.SimpleNamespace(Error=GError, idle_add=lambda fn: None)
modules = {
    "gi": types.SimpleNamespace(require_version=lambda *a: None),
    "gi.repository": types.SimpleNamespace(Atspi=Atspi, GLib=GLib),
}
spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("native.py"))
native = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, modules):
    spec.loader.exec_module(native)


class Node:
    """An accessible. `answers` replaces a toolkit's point query: (x, y) -> child or None."""

    def __init__(self, role, name="", ext=(0, 0, 10, 10), parent=None, states=("showing",),
                 answers=None, pid=None):
        self.role, self.name, self.ext, self.parent = role, name, ext, parent
        self.states = set(states)
        self.children = []
        self.answers = answers
        self.pid = pid
        self.calls = 0
        if parent is not None:
            parent.children.append(self)

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_state_set(self):
        return types.SimpleNamespace(contains=lambda s: s in self.states)

    def get_component_iface(self):
        return self

    def get_extents(self, coord):
        x, y, w, h = self.ext if self.ext else (-2147483648, -2147483648, 1, 1)
        return types.SimpleNamespace(x=x, y=y, width=w, height=h)

    def get_accessible_at_point(self, x, y, coord):
        self.calls += 1
        if self.answers is not None:
            return self.answers(x, y)
        for c in self.children:
            if c.ext and native.inside(c.ext, x, y):
                return c
        return None

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, i):
        return self.children[i]

    def get_parent(self):
        return self.parent

    def get_process_id(self):
        n = self
        while n.pid is None:
            n = n.parent
        return n.pid


def app(pid, name):
    desktop = Node("desktop frame", ext=None)
    return desktop, Node("application", name, ext=None, parent=desktop, pid=pid)


def window(pid, title, rect, frame, **extra):
    return dict({"pid": pid, "title": title, "rect": rect, "frame": frame}, **extra)


def at(helper, win, point, kit="gtk", deadline=None, **extra):
    req = dict({"window": win, "point": {"x": point[0], "y": point[1]}, "kit": kit, "g": 2, "c": 2,
                "deadline": deadline or native.mono() + 5000}, **extra)
    return helper.cmd_at(req)


# GIMP's "Change Foreground Color" dialog at device (2,222) 1188x734 inside a 0,166 frame:
# frame units are (device - origin) / 2 + floor(origin / 2), so the frame is (0,83) 596x396.
DIALOG = window(2193, "Change Foreground Color", [2, 222, 1188, 734], [0, 166, 1192, 792])


def gimp():
    desktop, gimp_app = app(2193, "gimp")
    Node("frame", "GNU Image Manipulation Program", (0, 27, 802, 629), gimp_app)
    dialog = Node("dialog", "Change Foreground Color", (0, 83, 596, 396), gimp_app)
    filler = Node("filler", "", (1, 111, 594, 367), dialog)
    Node("label", "HTML notation:", (217, 355, 160, 28), filler)
    entry = Node("text", "", (380, 355, 161, 28), filler, states=("showing", "editable"))
    hidden = Node("panel", "", (1, 111, 594, 367), filler, states=())
    Node("push button", "Ghost", (380, 355, 161, 28), hidden)
    return native.Helper(desktop), dialog, entry


class PointQuery(unittest.TestCase):
    def test_descends_by_point_queries_to_the_entry_and_reports_it_in_frame_units(self):
        helper, _, _ = gimp()
        # Device (896,736) is frame (1 + 894/2, 111 + 514/2) = (448, 368): inside the entry.
        found = at(helper, DIALOG, (896, 736))["element"]
        self.assertEqual(found["role"], "text")
        self.assertEqual(found["frame"], {"x": 380, "y": 355, "w": 161, "h": 28})
        self.assertEqual(found["space"], "gtk")
        self.assertEqual((found["editable"], found["secret"]), (True, False))

    def test_finds_the_window_by_title_and_never_a_hidden_element(self):
        helper, dialog, _ = gimp()
        dialog.children[0].answers = lambda x, y: dialog.children[0].children[2]
        found = at(helper, DIALOG, (896, 736))["element"]
        self.assertEqual(found["role"], "text")

    def test_never_lends_a_window_the_elements_of_another_with_its_title(self):
        # A window elsewhere that claims GIMP's process id and the dialog's title.
        helper, _, _ = gimp()
        elsewhere = dict(DIALOG, rect=[1402, 222, 1188, 734], frame=[1400, 166, 1192, 792])
        self.assertEqual(at(helper, elsewhere, (1402 + 894, 736)), {"element": None})

    def test_matches_an_untitled_popup_by_its_geometry(self):
        desktop, lo = app(4505, "soffice")
        Node("frame", "Untitled 1 - LibreOffice Calc", (0, 27, 1280, 707), lo)
        popup = Node("window", "", (210, 151, 98, 575), lo)
        table = Node("table", "", (211, 152, 80, 573), popup)
        Node("table cell", "10.5 pt", (213, 268, 76, 21), table)
        helper = native.Helper(desktop)
        win = window(4505, "", [420, 302, 196, 1150], [420, 302, 196, 1150], overrideRedirect=True)
        found = at(helper, win, (471, 556), kit="libreoffice")["element"]
        self.assertEqual((found["role"], found["name"]), ("table cell", "10.5 pt"))

    def test_looks_at_the_children_when_a_point_query_answers_wrongly(self):
        # Chromium's UI answers a point query on the omnibox with the tab title.
        desktop, chromium = app(5493, "Chromium")
        frame = Node("frame", "about:blank - Chromium", (0, 27, 1280, 707), chromium)
        title = Node("static", "about:blank", (171, 27, 168, 41), frame)
        bar = Node("tool bar", "", (0, 67, 1280, 46), frame)
        frame.answers = lambda x, y: title
        Node("entry", "Address and search bar", (158, 78, 993, 24), bar,
             states=("showing", "editable", "focused"))
        Node("document web", "", (0, 228, 2560, 1240), frame)
        helper = native.Helper(desktop)
        win = window(5493, "about:blank - Chromium", [0, 54, 2560, 1414], [0, 54, 2560, 1414])
        found = at(helper, win, (896, 179), kit="chromium")["element"]
        self.assertEqual((found["role"], found["space"]), ("entry", "chrome"))
        # Web content is CDP's: the walk stops at the content's container.
        self.assertEqual(at(helper, win, (1200, 800), kit="chromium")["element"]["role"], "frame")

    def test_finds_the_page_inside_a_notebook_through_its_selected_tab(self):
        # A notebook's tabs span their labels; the selected tab's page fills the notebook.
        desktop, mousepad = app(77, "mousepad")
        frame = Node("frame", "Untitled 1 - Mousepad", (1, 27, 640, 508), mousepad)
        notebook = Node("page tab list", "", (1, 80, 640, 455), frame, answers=lambda x, y: None)
        Node("page tab", "Untitled 2", (100, 80, 98, 30), notebook)
        tab = Node("page tab", "Untitled 1", (1, 80, 98, 30), notebook, states=("showing", "selected"))
        Node("text", "", (1, 110, 640, 425), Node("scroll pane", "", (1, 110, 640, 425), tab),
             states=("showing", "editable"))
        helper = native.Helper(desktop)
        win = window(77, "Untitled 1 - Mousepad", [2, 110, 1280, 960], [0, 54, 1284, 1018])
        found = at(helper, win, (600, 600))["element"]
        self.assertEqual((found["role"], found["frame"]), ("text", {"x": 1, "y": 110, "w": 640, "h": 425}))
        # On the other tab's label, that tab; beside the labels, the notebook itself.
        self.assertEqual(at(helper, win, (300, 170))["element"]["name"], "Untitled 2")
        self.assertEqual(at(helper, win, (600, 170))["element"]["role"], "page tab list")

    def test_reports_no_element_for_an_app_without_accessibility(self):
        helper, _, _ = gimp()
        win = window(999, "xterm", [0, 0, 100, 100], [0, 0, 100, 100])
        self.assertEqual(at(helper, win, (10, 10)), {"element": None})


def calc(shift):
    """Calc at device (0,110). While its window is new, VCL reports its parts `shift` too high;
    the GTK widgets inside its tool bars never are."""
    desktop, lo = app(4505, "soffice")
    frame = Node("frame", "Untitled 2 - LibreOffice Calc", (0, 27, 1280, 707), lo)
    host = Node("panel", "", (0, 80, 1280, 654), frame)
    pane = Node("root pane", "Untitled 2 - LibreOffice Calc", (0, 80 - shift, 1280, 654), host)
    bars = Node("panel", "", (0, 80 - shift, 1280, 78), pane)
    formatting = Node("tool bar", "Formatting", (0, 119 - shift, 1280, 39), bars)
    Node("toggle button", "Bold", (316, 121 - shift, 34, 36), formatting)
    size = Node("panel", "Font Size", (210, 125 - shift, 98, 26), formatting)
    combo = Node("combo box", "", (210, 125, 98, 26), size)
    Node("text", "", (210, 125, 62, 26), combo, states=("showing", "editable"))
    lower = Node("panel", "", (0, 158 - shift, 1280, 552), pane)
    formula = Node("tool bar", "Formula Tool Bar", (0, 158 - shift, 1221, 36), lower)
    box = Node("combo box", "", (4, 161, 155, 26), formula)
    Node("text", "", (4, 161, 119, 26), box, states=("showing", "editable"))
    return native.Helper(desktop)


CALC = window(4505, "Untitled 2 - LibreOffice Calc", [0, 110, 2560, 1358], [0, 54, 2560, 1414])


class LibreOffice(unittest.TestCase):
    def test_corrects_the_vcl_offset_and_leaves_its_gtk_widgets_alone(self):
        for shift in (25, 0):
            helper = calc(shift)
            bold = at(helper, CALC, (663, 274), kit="libreoffice")["element"]
            self.assertEqual((bold["name"], bold["frame"]["y"]), ("Bold", 121), shift)
            size = at(helper, CALC, (467, 274), kit="libreoffice")["element"]
            self.assertEqual((size["role"], size["frame"]["y"]), ("text", 125), shift)

    def test_names_the_cell_reference_box(self):
        found = at(calc(25), CALC, (128, 347), kit="libreoffice")["element"]
        self.assertEqual((found["role"], found["name"]), ("text", "Name Box"))
        self.assertEqual(found["frame"], {"x": 4, "y": 161, "w": 119, "h": 26})

    def test_trees_carry_corrected_frames_and_skip_unnamed_parts(self):
        helper = calc(25)
        req = {"window": CALC, "kit": "libreoffice", "g": 2, "c": 2, "deadline": native.mono() + 5000}
        tree = helper.cmd_tree(req)
        named = {e["name"]: e["frame"]["y"] for e in tree["elements"]}
        self.assertEqual(named["Bold"], 121)
        self.assertEqual(named["Name Box"], 161)
        self.assertNotIn("", named)
        self.assertFalse(tree["truncated"])


class Trees(unittest.TestCase):
    def test_asks_the_toolkit_for_the_showing_elements_and_keeps_the_named_ones(self):
        helper, dialog, entry = gimp()
        ok = Node("push button", "OK", (500, 440, 80, 28), dialog.children[0])
        web = Node("document web", "Page", (0, 0, 100, 100), dialog.children[0])
        asked = []

        def get_matches(rule, order, count, traverse):
            asked.append((rule[0], count))
            return [dialog.children[0], entry, ok, web]
        dialog.get_collection_iface = lambda: types.SimpleNamespace(get_matches=get_matches)
        dialog.get_child_count = lambda: (_ for _ in ()).throw(AssertionError("walked"))
        req = {"window": DIALOG, "kit": "gtk", "g": 2, "c": 2, "deadline": native.mono() + 5000}
        tree = helper.cmd_tree(req)
        self.assertEqual([e["name"] for e in tree["elements"]], ["OK"])
        self.assertEqual(asked, [(["showing"], native.TREE_LIMIT)])

    def test_walks_libreoffice_and_toolkits_without_the_query(self):
        helper = calc(0)
        root = helper.desktop.children[0].children[0]
        root.get_collection_iface = lambda: (_ for _ in ()).throw(AssertionError("asked"))
        req = {"window": CALC, "kit": "libreoffice", "g": 2, "c": 2, "deadline": native.mono() + 5000}
        self.assertIn("Bold", [e["name"] for e in helper.cmd_tree(req)["elements"]])
        helper, _, _ = gimp()
        req = {"window": DIALOG, "kit": "gtk", "g": 2, "c": 2, "deadline": native.mono() + 5000}
        self.assertEqual([e["name"] for e in helper.cmd_tree(req)["elements"]],
                         ["Change Foreground Color", "HTML notation:"])


class Deadlines(unittest.TestCase):
    def reply(self, helper, req):
        out = io.StringIO()
        with patch.object(sys, "stdout", out):
            helper.handle(json.dumps(req))
        return json.loads(out.getvalue())

    def test_a_query_past_its_deadline_is_unknown_not_empty(self):
        helper, _, _ = gimp()
        req = {"id": 3, "cmd": "at", "window": DIALOG, "point": {"x": 896, "y": 736}, "kit": "gtk",
               "g": 2, "c": 2, "deadline": native.mono() - 1}
        self.assertEqual(self.reply(helper, req), {"unknown": True, "id": 3, "ok": True})

    def test_an_application_that_does_not_answer_leaves_the_element_unknown(self):
        helper, _, _ = gimp()
        helper.desktop.children[0].get_child_count = lambda: (_ for _ in ()).throw(GError("timeout"))
        req = {"id": 4, "cmd": "focused", "window": DIALOG, "kit": "gtk", "g": 2, "c": 2,
               "deadline": native.mono() + 5000}
        self.assertEqual(self.reply(helper, req), {"unknown": True, "id": 4, "ok": True})


def event(kind, source, on=True):
    return types.SimpleNamespace(type=kind, source=source, detail1=1 if on else 0)


def focused(helper, win=DIALOG, kit="gtk"):
    return helper.cmd_focused({"window": win, "kit": kit, "g": 2, "c": 2,
                               "deadline": native.mono() + 5000})["element"]


class Focus(unittest.TestCase):
    def test_follows_focus_events_to_the_deepest_element_still_focused(self):
        helper, dialog, entry = gimp()
        spin = Node("spin button", "", (457, 183, 126, 28), dialog.children[0],
                    states=("showing", "editable"))
        helper.on_event(event("object:state-changed:focused", entry))
        entry.states.add("focused")
        dialog.states.add("focused")
        helper.on_event(event("object:state-changed:focused", dialog))
        self.assertEqual(focused(helper)["frame"], {"x": 380, "y": 355, "w": 161, "h": 28})
        # Focus moved on; the entry's stale event no longer counts.
        entry.states.discard("focused")
        spin.states.add("focused")
        helper.on_event(event("object:state-changed:focused", entry, on=False))
        helper.on_event(event("object:state-changed:focused", spin))
        self.assertEqual(focused(helper)["role"], "spin button")

    def test_ignores_focus_in_another_window(self):
        helper, dialog, entry = gimp()
        other = Node("push button", "Old", (10, 40, 50, 20), helper.desktop.children[0].children[0],
                     states=("showing", "focused"))
        helper.on_event(event("object:state-changed:focused", other))
        entry.states.add("focused")
        self.assertEqual(focused(helper)["role"], "text")

    def test_walks_the_window_when_no_event_has_been_seen(self):
        helper, _, entry = gimp()
        entry.states.add("focused")
        self.assertEqual(focused(helper)["role"], "text")
        entry.states.discard("focused")
        self.assertIsNone(focused(helper))

    def test_a_walk_cut_short_goes_on_between_requests_and_answers_the_next_query(self):
        helper, dialog, entry = gimp()
        entry.states.add("focused")
        later = []
        helper.idle = later.append
        req = {"window": DIALOG, "kit": "gtk", "g": 2, "c": 2, "deadline": native.mono() + 5000}
        spent = [0]

        # Each step of the walk costs 100 ms of a 250 ms budget.
        def slow_check(q):
            spent[0] += 100
            if spent[0] >= 250:
                raise native.Expired()
        with patch.object(native.Query, "check", slow_check):
            with self.assertRaises(native.Expired):
                helper.focused_by_walk(dialog, native.Query(req))
        self.assertEqual(len(later), 1)
        self.assertIn(dialog, helper.walks)
        while later[0]():
            pass
        self.assertEqual(helper.walks, {})
        dialog.get_child_count = lambda: (_ for _ in ()).throw(AssertionError("walked again"))
        self.assertEqual(focused(helper)["role"], "text")

    def test_a_walked_answer_that_lost_focus_is_walked_again(self):
        helper, _, entry = gimp()
        entry.states.add("focused")
        self.assertEqual(focused(helper)["role"], "text")
        entry.states.discard("focused")
        spin = Node("spin button", "", (457, 183, 126, 28), entry.parent, states=("showing", "focused"))
        self.assertEqual(focused(helper)["role"], "spin button")
        spin.states.discard("focused")
        self.assertIsNone(focused(helper))

    def test_accepts_focus_in_a_combo_box_popup_list(self):
        desktop, lo = app(4505, "soffice")
        Node("frame", "Untitled 1 - LibreOffice Calc", (0, 27, 1280, 707), lo)
        popup = Node("window", "", (210, 151, 98, 575), lo)
        cell = Node("table cell", "10 pt", (213, 247, 76, 21), popup, states=("showing", "focused"))
        helper = native.Helper(desktop)
        helper.on_event(event("object:state-changed:focused", cell))
        win = window(4505, "Untitled 1 - LibreOffice Calc", [0, 110, 2560, 1358], [0, 54, 2560, 1414])
        self.assertEqual(focused(helper, win, "libreoffice")["name"], "10 pt")


def gimp_menu():
    helper, _, _ = gimp()
    frame = helper.desktop.children[0].children[0]
    bar = Node("menu bar", "", (1, 55, 800, 25), Node("filler", "", (1, 55, 800, 600), frame))
    file_menu = Node("menu", "File", (1, 55, 38, 25), bar)
    Node("menu", "Edit", (39, 55, 39, 25), bar)
    Node("menu item", "Open...", (7, 136, 296, 25), file_menu)
    recent = Node("menu", "Open Recent", (7, 236, 296, 25), file_menu)
    Node("menu item", "Document History", (303, 236, 200, 25), recent)
    Node("menu item", "Undo", None, bar.children[1], states=())
    # The tool button the menu covers.
    Node("toggle button", "", (38, 144, 37, 34), frame)
    win = window(2193, "", [-10, 150, 640, 1108], [-10, 150, 640, 1108], overrideRedirect=True)
    parent = window(2193, "GNU Image Manipulation Program", [2, 110, 1600, 1200], [0, 54, 1604, 1258])
    return helper, file_menu, win, parent


class Menus(unittest.TestCase):
    def test_finds_an_item_of_a_menu_the_app_announced_open(self):
        helper, file_menu, win, _ = gimp_menu()
        file_menu.states.add("selected")
        helper.on_event(event("object:state-changed:selected", file_menu))
        found = at(helper, win, (115, 296))["element"]
        self.assertEqual((found["role"], found["name"]), ("menu item", "Open..."))

    def test_finds_an_item_of_an_open_submenu(self):
        helper, file_menu, win, _ = gimp_menu()
        file_menu.states.add("selected")
        helper.on_event(event("object:state-changed:selected", file_menu))
        recent = file_menu.children[1]
        # Device (700, 496) is frame (345, 248): in the submenu, right of the File menu.
        self.assertEqual(at(helper, win, (700, 496)), {"element": None})
        recent.states.add("selected")
        self.assertEqual(at(helper, win, (700, 496))["element"]["name"], "Document History")

    def test_finds_the_selected_menu_in_the_parents_menu_bar_without_events(self):
        helper, file_menu, win, parent = gimp_menu()
        file_menu.states.add("selected")
        found = at(helper, win, (115, 296), parent=parent)["element"]
        self.assertEqual(found["name"], "Open...")
        file_menu.states.discard("selected")
        self.assertEqual(at(helper, win, (115, 296), parent=parent), {"element": None})


if __name__ == "__main__":
    unittest.main()
