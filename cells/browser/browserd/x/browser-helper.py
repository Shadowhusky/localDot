import runpy


def clear_selections(open_display):
    connection = open_display()
    try:
        failures = []
        connection.set_error_handler(lambda error, request: failures.append(True))
        selections = [connection.intern_atom(name) for name in ['PRIMARY', 'SECONDARY', 'CLIPBOARD']]
        buffers = [connection.intern_atom('CUT_BUFFER' + str(index)) for index in range(8)]
        empty_owner = connection.create_resource_object('window', 0)
        root = connection.screen().root
        for selection in selections:
            empty_owner.set_selection_owner(selection, 0)
        for buffer in buffers:
            root.delete_property(buffer)
        connection.sync()
        if failures or any(connection.get_selection_owner(selection) != 0 for selection in selections):
            raise RuntimeError('selection cleanup failed')
        if any(root.get_property(buffer, 0, 0, 1) is not None for buffer in buffers):
            raise RuntimeError('selection cleanup failed')
        connection.sync()
        if failures:
            raise RuntimeError('selection cleanup failed')
        return {'cleared': True}
    finally:
        connection.close()


def browser_commands(base, open_display=None, surface_query=None):
    class BrowserCommands(base):
        def cmd_userKeys(self, arguments):
            if set(arguments) - {'id', 'cmd', 'combo'}:
                raise RuntimeError('user keys refused')
            return super().cmd_keys(arguments)

        def cmd_userClick(self, arguments):
            if set(arguments) - {'id', 'cmd', 'x', 'y', 'button', 'count', 'holdMs', 'mods'}:
                raise RuntimeError('user click refused')
            return super().cmd_click(arguments)

        def cmd_windows(self, arguments):
            original = self.NET_STACK
            if self.prop(self.root, original) is None:
                self.NET_STACK = self.d.intern_atom('_NET_CLIENT_LIST')
            try:
                return super().cmd_windows(arguments)
            finally:
                self.NET_STACK = original

        def cmd_clearSelections(self, arguments):
            if open_display is None or set(arguments) - {'id', 'cmd'}:
                raise RuntimeError('selection cleanup refused')
            return clear_selections(open_display)

        def cmd_surface(self, arguments):
            window = arguments.get('window')
            if (surface_query is None or set(arguments) - {'id', 'cmd', 'window'} or
                    type(window) is not int or window <= 0 or window > 0xffffffff):
                raise RuntimeError('surface inspection refused')
            return surface_query(self, window)
    return BrowserCommands


def main():
    from browser_surface import native_surface
    module = runpy.run_path('/opt/localdot/xhelper.py')
    module['main'].__globals__['Commands'] = browser_commands(module['Commands'], module['display'].Display, native_surface)
    module['main']()


if __name__ == '__main__':
    main()
