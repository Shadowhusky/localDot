from pathlib import Path
import runpy
import unittest


wrapper = runpy.run_path(str(Path(__file__).with_name('browser-helper.py')))


class Display:
    def intern_atom(self, name):
        if name != '_NET_CLIENT_LIST':
            raise AssertionError(name)
        return 'clients'


class Commands:
    def __init__(self, stacking):
        self.NET_STACK = 'stack'
        self.root = object()
        self.d = Display()
        self.stacking = stacking
        self.fail = False

    def prop(self, root, atom):
        if root is not self.root or atom != 'stack':
            raise AssertionError('unexpected property read')
        return self.stacking

    def cmd_windows(self, arguments):
        if self.fail:
            raise RuntimeError('native inspection failed')
        return {'source': self.NET_STACK, 'arguments': arguments}

    def cmd_keys(self, arguments):
        return {'keys': arguments['combo']}

    def cmd_click(self, arguments):
        return {'mods': arguments['mods']}


class BrowserHelperTests(unittest.TestCase):
    def test_user_aliases_delegate_only_known_arguments(self):
        helper = wrapper['browser_commands'](Commands)([])
        self.assertEqual(helper.cmd_userKeys({'combo': ['Control_L', 'l']}), {'keys': ['Control_L', 'l']})
        self.assertEqual(helper.cmd_userClick({'mods': ['Alt_L', 'Super_L']}), {'mods': ['Alt_L', 'Super_L']})
        with self.assertRaises(RuntimeError):
            helper.cmd_userKeys({'combo': ['Control_L', 'l'], 'extra': True})
        with self.assertRaises(RuntimeError):
            helper.cmd_userClick({'mods': [], 'extra': True})

    def test_preserves_available_stacking_property(self):
        helper = wrapper['browser_commands'](Commands)([3, 2, 1])
        self.assertEqual(helper.cmd_windows({})['source'], 'stack')
        self.assertEqual(helper.NET_STACK, 'stack')

    def test_does_not_replace_an_empty_valid_stacking_property(self):
        helper = wrapper['browser_commands'](Commands)([])
        self.assertEqual(helper.cmd_windows({})['source'], 'stack')

    def test_missing_property_uses_clients_and_restores_each_time(self):
        helper = wrapper['browser_commands'](Commands)(None)
        self.assertEqual(helper.cmd_windows({})['source'], 'clients')
        self.assertEqual(helper.NET_STACK, 'stack')
        helper.stacking = [4]
        self.assertEqual(helper.cmd_windows({})['source'], 'stack')

    def test_restores_original_atom_when_native_query_fails(self):
        helper = wrapper['browser_commands'](Commands)(None)
        helper.fail = True
        with self.assertRaises(RuntimeError):
            helper.cmd_windows({})
        self.assertEqual(helper.NET_STACK, 'stack')


class SelectionConnection:
    def __init__(self, failure=None):
        self.root = self
        self.failure = failure
        self.closed = False
        self.selections = []
        self.deleted = []
        self.reads = []

    def set_error_handler(self, handler):
        self.handler = handler

    def intern_atom(self, name):
        return name

    def create_resource_object(self, kind, identity):
        if (kind, identity) != ('window', 0):
            raise AssertionError('invalid empty owner')
        return self

    def screen(self):
        return self

    def set_selection_owner(self, atom, timestamp):
        if timestamp != 0:
            raise AssertionError('invalid timestamp')
        self.selections.append(atom)

    def delete_property(self, atom):
        self.deleted.append(atom)

    def sync(self):
        if self.failure == 'error':
            self.handler(object(), object())
        if self.failure == 'raise':
            raise RuntimeError('transport failed')

    def get_selection_owner(self, atom):
        return 8 if self.failure == 'owner' else 0

    def get_property(self, atom, kind, offset, length):
        self.reads.append((kind, offset, length))
        return object() if self.failure == 'buffer' else None

    def close(self):
        self.closed = True


class SelectionCleanupTests(unittest.TestCase):
    def test_clears_all_selections_and_buffers_then_closes_connection(self):
        connection = SelectionConnection()
        self.assertEqual(wrapper['clear_selections'](lambda: connection), {'cleared': True})
        self.assertEqual(connection.selections, ['PRIMARY', 'SECONDARY', 'CLIPBOARD'])
        self.assertEqual(connection.deleted, ['CUT_BUFFER' + str(index) for index in range(8)])
        self.assertEqual(connection.reads, [(0, 0, 1)] * 8)
        self.assertTrue(connection.closed)

    def test_refuses_unconfirmed_cleanup_and_always_closes_connection(self):
        for failure in ['error', 'raise', 'owner', 'buffer']:
            with self.subTest(failure=failure):
                connection = SelectionConnection(failure)
                with self.assertRaises(RuntimeError):
                    wrapper['clear_selections'](lambda: connection)
                self.assertTrue(connection.closed)

    def test_native_wrapper_refuses_unexpected_fields_before_opening_display(self):
        opened = []
        helper = wrapper['browser_commands'](Commands, lambda: opened.append(True))(None)
        with self.assertRaises(RuntimeError):
            helper.cmd_clearSelections({'id': 1, 'cmd': 'clearSelections', 'text': 'private'})
        self.assertEqual(opened, [])


if __name__ == '__main__':
    unittest.main()
