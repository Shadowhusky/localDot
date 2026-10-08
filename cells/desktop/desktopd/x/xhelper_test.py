import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

# X protocol values the helper reads; python-xlib itself is only in the desktop image.
X = types.SimpleNamespace(
    NONE=0, CurrentTime=0, InputOnly=2, IsViewable=2, IsUnmapped=0, ZPixmap=2, LSBFirst=0,
    KeyPress=2, KeyRelease=3, ButtonPress=4, ButtonRelease=5, MotionNotify=6,
    DestroyNotify=17, UnmapNotify=18, MapNotify=19, ConfigureNotify=22, PropertyNotify=28,
    ClientMessage=33, MappingNotify=34, PropertyChangeMask=1 << 22, SubstructureNotifyMask=1 << 19,
    SubstructureRedirectMask=1 << 20,
)
xinput = types.SimpleNamespace(
    RawKeyPress=13, RawKeyRelease=14, RawButtonPress=15, RawButtonRelease=16,
    RawKeyPressMask=1 << 13, RawKeyReleaseMask=1 << 14, RawButtonPressMask=1 << 15,
    RawButtonReleaseMask=1 << 16, AllDevices=0,
)
rq = types.SimpleNamespace(Struct=lambda *a: a, Card16=lambda n: n, Card32=lambda n: n, Pad=lambda n: n)
modules = {
    "Xlib": types.SimpleNamespace(X=X, display=types.SimpleNamespace()),
    "Xlib.ext": types.SimpleNamespace(damage=types.SimpleNamespace(), ge=types.SimpleNamespace(), xinput=xinput),
    "Xlib.protocol": types.SimpleNamespace(event=types.SimpleNamespace(ClientMessage=lambda **kw: kw), rq=rq),
}
spec = importlib.util.spec_from_file_location("xhelper", Path(__file__).with_name("xhelper.py"))
xhelper = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, modules):
    spec.loader.exec_module(xhelper)

CARET = [400, 300, 4, 36]
FIELD = [380, 290, 300, 56]
DIALOG = [0, 166, 1192, 792]


class Timeline:
    """A fake monotonic clock: sleeping advances it and fires the events scheduled until then."""

    def __init__(self):
        self.t = 100_000.0
        self.events = []

    def clock(self):
        return self.t

    def at(self, ms, fire):
        self.events.append((self.t + ms, fire))

    def sleep(self, seconds):
        self.t += seconds * 1000
        due = sorted((e for e in self.events if e[0] <= self.t), key=lambda e: e[0])
        self.events = [e for e in self.events if e[0] > self.t]
        for when, fire in due:
            fire(when)


def helper(answers=False):
    """Commands without an X server: the fake clock drives settle, and `ping` is scripted."""
    time = Timeline()
    screen = xhelper.Screen(clock=time.clock)
    cmds = xhelper.Commands.__new__(xhelper.Commands)
    cmds.screen = screen
    cmds.pause = time.sleep
    cmds.pinged = 0

    def ping():
        cmds.pinged += 1
        if not answers:
            return None
        screen.expect(cmds.pinged)
        return cmds.pinged
    cmds.ping = ping
    return time, screen, cmds


def settle(time, cmds, **req):
    start = time.t
    result = cmds.cmd_settle(req)
    return result, time.t - start


class AmbientDamage(unittest.TestCase):
    def test_a_blinking_caret_does_not_hold_settle_open(self):
        time, screen, cmds = helper()
        screen.add(CARET, time.t - 250)
        screen.add(CARET, time.t - 40)
        screen.arm()
        time.at(150, lambda t: screen.add(CARET, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400, verb="key")
        self.assertEqual(result["noVisibleChange"], True)
        self.assertEqual(result["changed"], [])
        self.assertAlmostEqual(took, 400, delta=11)

    def test_a_change_beside_the_caret_still_counts(self):
        time, screen, cmds = helper()
        screen.add(CARET, time.t - 100)
        screen.arm()
        time.at(150, lambda t: screen.add(CARET, t))
        time.at(30, lambda t: screen.add([600, 300, 18, 36], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400)
        self.assertEqual(result["noVisibleChange"], False)
        self.assertEqual(result["changed"], [[600, 300, 18, 36]])
        self.assertAlmostEqual(took, 280, delta=11)

    def test_a_caret_that_blinked_outside_the_short_window_is_still_ambient(self):
        # GTK's 1200 ms blink: on for 800 ms, off for 400 ms; the last toggle was 350 ms ago.
        time, screen, cmds = helper()
        for ago in (1550, 1150, 750, 350):
            screen.add(CARET, time.t - ago)
        screen.arm()
        time.at(50, lambda t: screen.add(CARET, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400, verb="key")
        self.assertEqual(result["noVisibleChange"], True)
        self.assertAlmostEqual(took, 400, delta=11)

    def test_damage_seen_once_before_the_ambient_window_is_a_change(self):
        time, screen, cmds = helper()
        screen.add(CARET, time.t - 600)
        screen.arm()
        time.at(150, lambda t: screen.add(CARET, t))
        result, _ = settle(time, cmds, quietMs=250, firstMs=400)
        self.assertEqual(result["noVisibleChange"], False)

    def test_a_burst_on_one_rect_is_not_periodic(self):
        # A button's press and release highlight, 80 ms apart, half a second before the next arm.
        time, screen, cmds = helper()
        screen.add(FIELD, time.t - 600)
        screen.add(FIELD, time.t - 520)
        screen.arm()
        time.at(40, lambda t: screen.add(FIELD, t))
        result, _ = settle(time, cmds, quietMs=250, firstMs=400)
        self.assertEqual(result["changed"], [FIELD])

    def test_a_large_region_that_just_changed_is_not_ambient(self):
        time, screen, cmds = helper()
        screen.add(DIALOG, time.t - 50)
        screen.arm()
        time.at(60, lambda t: screen.add(DIALOG, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400)
        self.assertEqual(result["changed"], [DIALOG])
        self.assertAlmostEqual(took, 310, delta=11)

    def test_marching_ants_are_ambient_but_a_dab_inside_them_counts(self):
        canvas = [392, 228, 1356, 1082]
        time, screen, cmds = helper()
        for ago in range(1400, 0, -200):
            screen.add(canvas, time.t - ago)
        screen.arm()
        for ms in range(100, 3000, 200):
            time.at(ms, lambda t: screen.add(canvas, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400, verb="key")
        self.assertEqual(result["noVisibleChange"], True)
        self.assertAlmostEqual(took, 400, delta=11)

        screen.arm()
        time.at(30, lambda t: screen.add([900, 600, 60, 60], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=800, verb="click")
        self.assertEqual(result["changed"], [[900, 600, 60, 60]])
        self.assertAlmostEqual(took, 280, delta=11)


class WindowsDuringSettle(unittest.TestCase):
    def test_a_window_mapped_during_settle_holds_until_it_has_painted(self):
        time, screen, cmds = helper()
        screen.arm()
        time.at(5, lambda t: screen.add([840, 832, 794, 598], t))
        time.at(100, lambda t: screen.mapped(7, DIALOG, t))
        time.at(600, lambda t: screen.add([2, 222, 1188, 734], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=800, verb="click")
        self.assertEqual(result["quiet"], True)
        self.assertGreaterEqual(result["lastChange"] - (time.t - took), 600)
        self.assertAlmostEqual(took, 850, delta=11)
        self.assertTrue(any(r[0] <= DIALOG[0] and r[2] >= DIALOG[2] for r in result["changed"]))

    def test_a_window_that_never_paints_holds_until_the_cap(self):
        time, screen, cmds = helper()
        screen.arm()
        time.at(50, lambda t: screen.mapped(7, DIALOG, t))
        time.at(70, lambda t: screen.add([2000, 1300, 40, 40], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=800, timeoutMs=3000)
        self.assertEqual(result["quiet"], False)
        self.assertAlmostEqual(took, 3000, delta=11)

    def test_a_window_unmapped_before_it_painted_stops_holding(self):
        time, screen, cmds = helper()
        screen.arm()
        time.at(50, lambda t: screen.mapped(7, DIALOG, t))
        time.at(100, lambda t: screen.unmapped(7, DIALOG, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=800)
        self.assertEqual(result["quiet"], True)
        self.assertAlmostEqual(took, 350, delta=11)

    def test_a_busy_app_holds_settle_until_it_answers_and_draws(self):
        # GIMP's foreground swatch: the tooltip goes at once, the dialog maps 335 ms later.
        time, screen, cmds = helper(answers=True)
        screen.arm()
        time.at(5, lambda t: screen.add([840, 832, 794, 598], t))
        time.at(300, lambda t: screen.pong(1, t))
        time.at(335, lambda t: screen.mapped(9, DIALOG, t))
        for ms in (338, 357, 364, 549, 585):
            time.at(ms, lambda t: screen.add([2, 110, 1600, 1200], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=800, verb="click")
        self.assertEqual(cmds.pinged, 1)
        self.assertEqual(result["quiet"], True)
        self.assertAlmostEqual(took, 835, delta=11)

    def test_an_app_that_answers_at_once_adds_no_wait(self):
        time, screen, cmds = helper(answers=True)
        screen.arm()
        time.at(2, lambda t: screen.pong(1, t))
        time.at(20, lambda t: screen.add([600, 300, 18, 36], t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400, verb="type")
        self.assertEqual(result["noVisibleChange"], False)
        self.assertAlmostEqual(took, 270, delta=11)

    def test_an_app_that_never_answers_holds_until_the_cap(self):
        time, screen, cmds = helper(answers=True)
        screen.arm()
        result, took = settle(time, cmds, quietMs=250, firstMs=400, timeoutMs=3000, verb="key")
        self.assertEqual(result["quiet"], False)
        self.assertEqual(result["noVisibleChange"], True)
        self.assertAlmostEqual(took, 3000, delta=11)

    def test_only_inputs_an_app_handles_ping_it(self):
        for verb, pings in (("click", 1), ("scroll", 1), ("key", 1), ("type", 1), ("launch", 0), (None, 0)):
            with self.subTest(verb=verb):
                time, screen, cmds = helper()
                screen.arm()
                settle(time, cmds, firstMs=50, **({} if verb is None else {"verb": verb}))
                self.assertEqual(cmds.pinged, pings)

    def test_the_first_change_wait_is_the_requests(self):
        for first in (400, 800, 1500):
            with self.subTest(first=first):
                time, screen, cmds = helper()
                screen.arm()
                result, took = settle(time, cmds, quietMs=250, firstMs=first)
                self.assertEqual(result["noVisibleChange"], True)
                self.assertAlmostEqual(took, first, delta=11)

    def test_a_pong_for_another_token_is_ignored(self):
        time, screen, cmds = helper(answers=True)
        screen.arm()
        time.at(10, lambda t: screen.pong(99, t))
        result, took = settle(time, cmds, quietMs=250, firstMs=400, timeoutMs=1000, verb="key")
        self.assertEqual(result["quiet"], False)
        self.assertAlmostEqual(took, 1000, delta=11)


class Ping(unittest.TestCase):
    def commands(self, protocols):
        sent = []
        win = types.SimpleNamespace(get_wm_protocols=lambda: protocols,
                                    send_event=lambda msg, event_mask: sent.append((msg, event_mask)))
        cmds = xhelper.Commands.__new__(xhelper.Commands)
        cmds.screen = xhelper.Screen()
        cmds.pings = 0
        cmds.WM_PROTOCOLS, cmds.NET_WM_PING = 240, 253
        cmds.active_window = lambda: 77
        cmds.window = lambda wid: win if wid == 77 else None
        cmds.d = types.SimpleNamespace(flush=lambda: None)
        return cmds, win, sent

    def test_pings_the_active_window_and_expects_its_answer(self):
        cmds, win, sent = self.commands([1, 253])
        self.assertEqual(cmds.ping(), 1)
        self.assertEqual(sent, [({"window": win, "client_type": 240, "data": (32, [253, 1, 77, 0, 0])}, 0)])
        self.assertEqual(cmds.screen.pongs, {1: None})
        self.assertEqual(cmds.ping(), 2)

    def test_does_not_ping_a_window_that_cannot_answer(self):
        cmds, _, sent = self.commands([1])
        self.assertIsNone(cmds.ping())
        cmds.active_window = lambda: 0
        self.assertIsNone(cmds.ping())
        self.assertEqual(sent, [])

    def test_a_failing_ping_settles_without_it(self):
        cmds, win, _ = self.commands([253])
        win.send_event = lambda msg, event_mask: (_ for _ in ()).throw(RuntimeError("BadWindow"))
        self.assertIsNone(cmds.ping())


class Win:
    def __init__(self, wid, rect=None, viewable=True, input_only=False):
        self.id = wid
        self.rect = rect
        self.viewable = viewable
        self.input_only = input_only

    def get_attributes(self):
        return types.SimpleNamespace(win_class=X.InputOnly if self.input_only else 1,
                                     map_state=X.IsViewable if self.viewable else X.IsUnmapped)

    def get_geometry(self):
        x, y, w, h = self.rect
        return types.SimpleNamespace(x=x, y=y, width=w, height=h, border_width=0)


def listener():
    time = Timeline()
    screen = xhelper.Screen(clock=time.clock)
    screen.arm()
    lst = xhelper.Listener(screen)
    lst.WM_PROTOCOLS = 240
    lst.NET_WM_PING = 253
    return lst, screen


def configure(win, rect):
    x, y, w, h = rect
    return types.SimpleNamespace(type=X.ConfigureNotify, window=win, x=x, y=y, width=w, height=h,
                                 border_width=0)


class ListenerWindowEvents(unittest.TestCase):
    def test_a_map_records_a_change_that_waits_for_paint(self):
        lst, screen = listener()
        lst.window_event(types.SimpleNamespace(type=X.MapNotify, window=Win(9, DIALOG)), 10)
        s = screen.snapshot()
        self.assertEqual((s.count, s.unpainted, s.rects), (1, True, [DIALOG]))
        screen.add([100, 300, 20, 20], 12)
        self.assertEqual(screen.snapshot().unpainted, False)

    def test_input_only_unviewable_and_tiny_windows_are_not_changes(self):
        lst, screen = listener()
        for win in (Win(1, DIALOG, input_only=True), Win(2, DIALOG, viewable=False), Win(3, [10, 10, 1, 1]),
                    Win(4, [3000, 2000, 50, 50])):
            lst.window_event(types.SimpleNamespace(type=X.MapNotify, window=win), 10)
        self.assertEqual(screen.snapshot().count, 0)

    def test_a_restack_is_not_a_change_but_a_move_is(self):
        lst, screen = listener()
        win = Win(9, DIALOG)
        lst.window_event(types.SimpleNamespace(type=X.MapNotify, window=win), 10)
        screen.arm()
        lst.window_event(configure(win, DIALOG), 20)
        self.assertEqual(screen.snapshot().count, 0)
        lst.window_event(configure(win, [100, 166, 1192, 792]), 30)
        s = screen.snapshot()
        self.assertEqual(s.count, 2)
        self.assertEqual(s.rects, [DIALOG, [100, 166, 1192, 792]])

    def test_an_unmap_of_a_window_never_seen_viewable_is_not_a_change(self):
        lst, screen = listener()
        lst.window_event(types.SimpleNamespace(type=X.UnmapNotify, window=Win(5)), 10)
        self.assertEqual(screen.snapshot().count, 0)
        win = Win(9, DIALOG)
        lst.window_event(types.SimpleNamespace(type=X.MapNotify, window=win), 20)
        lst.window_event(types.SimpleNamespace(type=X.UnmapNotify, window=win), 30)
        s = screen.snapshot()
        self.assertEqual((s.count, s.unpainted), (2, False))

    def test_a_pong_is_recorded_for_an_expected_token_only(self):
        lst, screen = listener()
        screen.expect(4)
        pong = lambda token: types.SimpleNamespace(type=X.ClientMessage, client_type=240, data=(32, [253, token, 77, 0, 0]))
        lst.window_event(pong(5), 10)
        lst.window_event(types.SimpleNamespace(type=X.ClientMessage, client_type=241, data=(32, [253, 4, 77, 0, 0])), 11)
        self.assertIsNone(screen.snapshot(4).pong)
        lst.window_event(pong(4), 12)
        lst.window_event(pong(4), 50)
        self.assertEqual(screen.snapshot(4).pong, 12)


if __name__ == "__main__":
    unittest.main()
