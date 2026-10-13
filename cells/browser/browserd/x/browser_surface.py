import hashlib
import os
import time


class SurfaceUnavailable(Exception):
    pass


def inspect_surface(commands, window_id, atspi, read_executable=os.readlink, clock=time.monotonic):
    deadline = clock() + 0.9
    visited = 0
    focus_complete = True

    def budget(depth=0):
        nonlocal visited
        visited += 1
        if depth > 32 or visited > 1500 or clock() >= deadline:
            raise SurfaceUnavailable()

    def identity():
        budget()
        if commands.active_window() != window_id:
            raise SurfaceUnavailable()
        window = commands.window(window_id)
        process = commands.prop(window, commands.NET_PID)
        if process is None or len(process) != 1 or int(process[0]) <= 1:
            raise SurfaceUnavailable()
        process_id = int(process[0])
        if read_executable('/proc/' + str(process_id) + '/exe') != '/usr/lib/chromium/chromium':
            raise SurfaceUnavailable()
        geometry = window.get_geometry()
        position = commands.root.translate_coords(window, 0, 0)
        extents = commands.prop(window, commands.NET_EXTENTS)
        if extents is None:
            extents = [0, 0, 0, 0]
        if len(extents) != 4 or any(int(value) < 0 or int(value) > 256 for value in extents):
            raise SurfaceUnavailable()
        left, right, top, bottom = [int(value) for value in extents]
        return (process_id, position.x - left, position.y - top,
                geometry.width + left + right, geometry.height + top + bottom)

    def showing(node):
        states = node.get_state_set()
        return states.contains(atspi.StateType.VISIBLE) and states.contains(atspi.StateType.SHOWING)

    def children(node, maximum, check=budget):
        check()
        count = node.get_child_count()
        if not isinstance(count, int) or count < 0 or count > maximum:
            raise SurfaceUnavailable()
        result = []
        for position in range(count):
            check()
            result.append(node.get_child_at_index(position))
        return result

    def rectangle(node):
        rect = node.get_component_iface().get_extents(atspi.CoordType.SCREEN)
        values = [rect.x, rect.y, rect.width, rect.height]
        if any(not isinstance(value, int) or abs(value) > 8192 for value in values):
            raise SurfaceUnavailable()
        if rect.width <= 0 or rect.height <= 0:
            raise SurfaceUnavailable()
        return values

    try:
        atspi.set_timeout(100, 500)
        initial = identity()
        applications = [application for application in children(atspi.get_desktop(0), 100)
                        if application is not None and application.get_process_id() == initial[0]]
        if len(applications) != 1:
            raise SurfaceUnavailable()
        frames = []
        for frame in children(applications[0], 100):
            budget()
            if frame is None or not showing(frame):
                continue
            role = frame.get_role_name()
            if role in ['menu', 'dialog', 'alert']:
                raise SurfaceUnavailable()
            if role == 'frame' and frame.get_state_set().contains(atspi.StateType.ACTIVE):
                frames.append(frame)
        if len(frames) != 1:
            raise SurfaceUnavailable()
        documents = []
        chrome_focus = False

        def visit_chrome(node, depth=0):
            nonlocal chrome_focus
            budget(depth)
            if node is None:
                raise SurfaceUnavailable()
            if not showing(node):
                return
            role = node.get_role_name()
            if role in ['menu', 'dialog', 'alert']:
                raise SurfaceUnavailable()
            if role == 'document web':
                documents.append(node)
                return
            if node.get_state_set().contains(atspi.StateType.FOCUSED):
                chrome_focus = True
            for child in children(node, 200):
                visit_chrome(child, depth + 1)

        visit_chrome(frames[0])
        if len(documents) != 1:
            raise SurfaceUnavailable()
        document = documents[0]
        content = rectangle(document)
        url = document.get_document_iface().get_document_attribute_value('URI')
        if not isinstance(url, str) or not url or len(url) > 32768:
            raise SurfaceUnavailable()
        page_focus = False
        # Focus is optional metadata. Its search must not consume the budget needed
        # to verify the native window again, or a large page becomes unreadable.
        focus_deadline = min(deadline - 0.15, clock() + 0.35)
        focus_visited = 0

        def focus_budget(depth=0):
            nonlocal focus_visited
            focus_visited += 1
            if depth > 32 or focus_visited > 1500 or clock() >= focus_deadline:
                raise SurfaceUnavailable()

        def visit_focus(node, depth=0):
            nonlocal page_focus
            focus_budget(depth)
            if node is None:
                raise SurfaceUnavailable()
            # Editors can keep keyboard focus on an offscreen or zero-height node.
            # Native focus, not its painted rectangle, determines where keys go.
            if node.get_state_set().contains(atspi.StateType.FOCUSED):
                page_focus = True
                return
            if not showing(node):
                return
            for child in children(node, 200, focus_budget):
                visit_focus(child, depth + 1)
                if page_focus:
                    return

        def collection_focus():
            focus_budget()
            rule = atspi.MatchRule.new(
                atspi.StateSet.new([atspi.StateType.FOCUSED]), atspi.CollectionMatchType.ALL,
                {}, atspi.CollectionMatchType.ALL, [], atspi.CollectionMatchType.ALL,
                [], atspi.CollectionMatchType.ALL, False)
            matches = document.get_collection_iface().get_matches(
                rule, atspi.CollectionSortOrder.CANONICAL, 2, True)
            focus_budget()
            if len(matches) != 1:
                raise SurfaceUnavailable()
            node = matches[0]
            if node is None or not node.get_state_set().contains(atspi.StateType.FOCUSED):
                raise SurfaceUnavailable()
            # Confirm the result belongs to this document, without reading names or values.
            for depth in range(33):
                focus_budget(depth)
                if node == document:
                    return True
                node = node.get_parent()
                if node is None:
                    break
            raise SurfaceUnavailable()

        if not chrome_focus:
            try:
                # Chromium answers this native query in one call instead of thousands of
                # cross-process child reads. Retain a bounded fallback for older bindings.
                if document.get_state_set().contains(atspi.StateType.FOCUSED):
                    page_focus = True
                elif hasattr(atspi, 'MatchRule'):
                    page_focus = collection_focus()
                else:
                    visit_focus(document)
            except Exception:
                focus_complete = False
        if identity() != initial:
            raise SurfaceUnavailable()
        focus = 'chrome' if chrome_focus else 'page' if page_focus and focus_complete else 'unknown'
        return {'window': window_id, 'page': {
            'frame': content, 'windowFrame': list(initial[1:]),
            'urlHash': hashlib.sha256(url.encode('utf-8')).hexdigest(), 'focus': focus,
        }}
    except Exception:
        return {'window': window_id, 'page': None}


def native_surface(commands, window_id):
    try:
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        return inspect_surface(commands, window_id, Atspi)
    except Exception:
        return {'window': window_id, 'page': None}
