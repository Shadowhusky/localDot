import hashlib
from types import SimpleNamespace
import unittest

from browser_surface import inspect_surface


class Node:
    def __init__(self, role, children=None, states=None, rect=None):
        self.role = role
        self.children = children or []
        self.states = states or {'visible', 'showing'}
        self.rect = rect or [0, 174, 2560, 1426]
        self.url = 'https://example.com/page'

    def get_state_set(self):
        return SimpleNamespace(contains=lambda state: state in self.states)

    def get_role_name(self):
        return self.role

    def get_process_id(self):
        return 42

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, position):
        return self.children[position]

    def get_component_iface(self):
        return SimpleNamespace(get_extents=lambda _coordinates: SimpleNamespace(
            x=self.rect[0], y=self.rect[1], width=self.rect[2], height=self.rect[3]))

    def get_document_iface(self):
        def attribute(name):
            if name != 'URI':
                raise AssertionError('unexpected document read')
            return self.url
        return SimpleNamespace(get_document_attribute_value=attribute)


def setup():
    field = Node('entry', states={'visible', 'showing', 'focused'})
    document = Node('document web', [field])
    toolbar = Node('tool bar')
    frame = Node('frame', [toolbar, document], {'visible', 'showing', 'active'})
    application = Node('application', [frame])
    desktop = Node('desktop', [application])
    atspi = SimpleNamespace(StateType=SimpleNamespace(VISIBLE='visible', SHOWING='showing',
                            ACTIVE='active', FOCUSED='focused'), CoordType=SimpleNamespace(SCREEN=0),
                            get_desktop=lambda _number: desktop, set_timeout=lambda *_values: None)
    native_window = SimpleNamespace(get_geometry=lambda: SimpleNamespace(width=2560, height=1600))
    commands = SimpleNamespace(active_window=lambda: 8, window=lambda _identity: native_window,
                               NET_PID='pid', NET_EXTENTS='extents',
                               prop=lambda _window, atom: [42] if atom == 'pid' else [0, 0, 0, 0],
                               root=SimpleNamespace(translate_coords=lambda *_args: SimpleNamespace(x=0, y=0)))
    def inspect():
        return inspect_surface(commands, 8, atspi,
                               read_executable=lambda _path: '/usr/lib/chromium/chromium')
    return SimpleNamespace(inspect=inspect, commands=commands, atspi=atspi, field=field,
                           document=document, toolbar=toolbar, frame=frame, desktop=desktop)


class BrowserSurfaceTests(unittest.TestCase):
    def test_projects_physical_bounds_focus_and_hash_without_values_or_names(self):
        peer = setup()
        result = peer.inspect()
        self.assertEqual(result, {'window': 8, 'page': {
            'frame': [0, 174, 2560, 1426], 'windowFrame': [0, 0, 2560, 1600],
            'urlHash': hashlib.sha256(b'https://example.com/page').hexdigest(), 'focus': 'page'}})
        self.assertNotIn('example.com', str(result))

    def test_chrome_focus_takes_precedence_over_stale_page_focus(self):
        peer = setup()
        peer.toolbar.states.add('focused')
        self.assertEqual(peer.inspect()['page']['focus'], 'chrome')

    def test_missing_page_focus_is_unknown(self):
        peer = setup()
        peer.field.states.remove('focused')
        self.assertEqual(peer.inspect()['page']['focus'], 'unknown')

    def test_refuses_focus_changes_during_native_query(self):
        peer = setup()
        identities = iter([8, 9])
        peer.commands.active_window = lambda: next(identities)
        self.assertIsNone(peer.inspect()['page'])

    def test_refuses_non_chromium_native_window(self):
        peer = setup()
        result = inspect_surface(peer.commands, 8, peer.atspi, read_executable=lambda _path: '/bin/other')
        self.assertIsNone(result['page'])

    def test_refuses_multiple_visible_documents_and_native_dialogs(self):
        for role in ['document web', 'dialog', 'menu', 'alert']:
            with self.subTest(role=role):
                peer = setup()
                peer.frame.children.append(Node(role))
                self.assertIsNone(peer.inspect()['page'])

    def test_refuses_hidden_document_and_invalid_rectangles(self):
        for rect in [[0, 0, 0, 3], [0, 0, 3, -1], [0, 0, 9000, 3]]:
            peer = setup()
            peer.document.rect = rect
            self.assertIsNone(peer.inspect()['page'])
        peer = setup()
        peer.document.states.remove('showing')
        self.assertIsNone(peer.inspect()['page'])

    def test_bounds_tree_traversal_and_fixed_deadline(self):
        peer = setup()
        peer.frame.children = [Node('panel') for _position in range(201)]
        self.assertIsNone(peer.inspect()['page'])
        peer = setup()
        ticks = iter([0, 1])
        result = inspect_surface(peer.commands, 8, peer.atspi, clock=lambda: next(ticks))
        self.assertIsNone(result['page'])

    def test_focus_budget_exhaustion_keeps_verified_page_geometry(self):
        peer = setup()
        peer.document.children = [Node('section', [Node('section') for _ in range(100)])
                                  for _ in range(20)]
        page = peer.inspect()['page']
        self.assertIsNotNone(page)
        self.assertEqual(page['focus'], 'unknown')

    def test_focus_timeout_keeps_geometry_only_within_overall_deadline(self):
        for elapsed in [0.4, 1.0]:
            peer = setup()
            now = [0.0]
            def state():
                now[0] = elapsed
                return SimpleNamespace(contains=lambda _state: False)
            peer.field.get_state_set = state
            result = inspect_surface(peer.commands, 8, peer.atspi,
                                     read_executable=lambda _path: '/usr/lib/chromium/chromium',
                                     clock=lambda: now[0])
            if elapsed < 0.9:
                self.assertEqual(result['page']['focus'], 'unknown')
            else:
                self.assertIsNone(result['page'])

    def test_focus_budget_does_not_skip_final_window_check(self):
        peer = setup()
        peer.document.children = [Node('section', [Node('section') for _ in range(100)])
                                  for _ in range(20)]
        identities = iter([8, 9])
        peer.commands.active_window = lambda: next(identities)
        self.assertIsNone(peer.inspect()['page'])

    def collection(self, peer, matches):
        peer.atspi.MatchRule = SimpleNamespace(new=lambda *args: object())
        peer.atspi.StateSet = SimpleNamespace(new=lambda states: states)
        peer.atspi.CollectionMatchType = SimpleNamespace(ALL=0)
        peer.atspi.CollectionSortOrder = SimpleNamespace(CANONICAL=0)
        def get_matches(rule, order, count, traverse):
            self.assertEqual(count, 2)
            self.assertTrue(traverse)
            return matches
        peer.document.get_collection_iface = lambda: SimpleNamespace(get_matches=get_matches)

    def test_native_collection_finds_offscreen_editor_focus(self):
        peer = setup()
        peer.field.states.remove('showing')
        peer.field.get_parent = lambda: peer.document
        self.collection(peer, [peer.field])
        peer.document.get_child_count = lambda: self.fail('should not walk page children')
        self.assertEqual(peer.inspect()['page']['focus'], 'page')

    def test_document_itself_can_hold_focus(self):
        peer = setup()
        peer.document.states.add('focused')
        self.collection(peer, [])
        self.assertEqual(peer.inspect()['page']['focus'], 'page')

    def test_native_collection_rejects_ambiguous_or_unrelated_focus(self):
        for count in [0, 1, 2]:
            peer = setup()
            peer.field.get_parent = lambda: None
            self.collection(peer, [peer.field] * count)
            self.assertEqual(peer.inspect()['page']['focus'], 'unknown')

    def test_refuses_missing_document_attribute_without_exposing_exception_text(self):
        peer = setup()
        peer.document.url = ''
        self.assertEqual(peer.inspect(), {'window': 8, 'page': None})


if __name__ == '__main__':
    unittest.main()
