#!/usr/bin/python3
"""Bounded AT-SPI metadata queries. Never read a control's text or value."""
import json
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

request = json.loads(sys.argv[1])
mode = request["mode"]
deadline = time.monotonic() + 0.9
Atspi.set_timeout(100, 500)
visited = 0
matches = []


def walk(node, roles=(), names=(), depth=0):
    global visited
    if node is None or depth > 28 or visited >= 1500 or time.monotonic() >= deadline:
        return
    visited += 1
    try:
        role = node.get_role_name()
        name = node.get_name() or "" if role == "tool bar" else ""
        wanted = (
            (mode == "focused" and role in ("text", "entry", "password text", "terminal", "table", "paragraph") and node.get_state_set().contains(Atspi.StateType.FOCUSED))
            or (mode == "content" and role == "document web")
            or (
                mode == "namebox"
                and role == "text"
                and "Formula Tool Bar" in names
                and roles and roles[-1] == "combo box"
            )
        )
        if wanted:
            if mode != "namebox":
                name = node.get_name() or ""
            rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if rect.x > -10000 and rect.y > -10000 and rect.width > 1 and rect.height > 1:
                matches.append({
                    "role": role,
                    "name": "Name Box" if mode == "namebox" else name,
                    "frame": {"x": rect.x, "y": rect.y, "w": rect.width, "h": rect.height},
                    "ancestorRoles": list(roles),
                    "depth": depth,
                })
        # The spreadsheet table can expose billions of children. The focused table itself is
        # enough to classify cell typing; do not enumerate cells or their contents.
        if role in ("table", "table cell", "menu"):
            return
        for i in range(min(node.get_child_count(), 200)):
            if time.monotonic() >= deadline:
                break
            walk(node.get_child_at_index(i), roles + (role,), names + (name,), depth + 1)
    except Exception:
        return


desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app is None or app.get_process_id() != request["pid"]:
        continue
    for j in range(min(app.get_child_count(), 100)):
        frame = app.get_child_at_index(j)
        if frame is not None and frame.get_name() == request["title"]:
            walk(frame)

# An alias is offered only when its role/ancestor path identifies exactly one visible control.
if request["mode"] == "namebox":
    result = matches[0] if len(matches) == 1 else None
else:
    result = max(matches, key=lambda x: x["depth"]) if matches else None
print(json.dumps(result))
