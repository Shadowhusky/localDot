"""Bind a key to a command in an xfce4-keyboard-shortcuts channel file, keeping every other key.

xfsettingsd reads /commands/custom once it has copied the defaults there (override = true), and
/commands/default until then, so the key goes into whichever set is live.
"""

import os
import sys
import xml.etree.ElementTree as ET


def find(parent, name):
    return next((p for p in parent.findall("property") if p.get("name") == name), None)


def ensure(parent, name):
    node = find(parent, name)
    if node is None:
        node = ET.SubElement(parent, "property", {"name": name, "type": "empty"})
    return node


def main(path, key, command):
    tree = ET.parse(path)
    commands = ensure(tree.getroot(), "commands")
    custom = find(commands, "custom")
    override = None if custom is None else find(custom, "override")
    live = custom if override is not None and override.get("value") == "true" else ensure(commands, "default")
    binding = ensure(live, key)
    if binding.get("type") == "string" and binding.get("value") == command:
        return
    binding.attrib.update({"type": "string", "value": command})
    tree.write(path + ".new", encoding="UTF-8", xml_declaration=True)
    os.replace(path + ".new", path)


if __name__ == "__main__":
    main(*sys.argv[1:4])
