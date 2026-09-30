"""Print raw AT-SPI screen extents for elements whose names match, bypassing Cua Driver.

usage (inside the desktop, as the desktop user, with its session bus):
  python3 atspi-extents.py <app name substring> <element name>...
"""
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

app_filter, wanted = sys.argv[1].lower(), set(sys.argv[2:])
desktop = Atspi.get_desktop(0)


def walk(node, depth):
    try:
        name, role = node.get_name(), node.get_role_name()
        count = node.get_child_count()
    except Exception:
        return
    if name in wanted:
        try:
            ext = node.get_extents(Atspi.CoordType.SCREEN)
            print(f"{role} {name!r}: x={ext.x} y={ext.y} w={ext.width} h={ext.height}")
        except Exception as err:
            print(f"{role} {name!r}: no extents ({err})")
    # A Calc sheet reports millions of cells; walking them never finishes.
    if count > 500 or depth > 40:
        return
    for i in range(count):
        walk(node.get_child_at_index(i), depth + 1)


for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app is not None and app_filter in (app.get_name() or "").lower():
        walk(app, 0)
