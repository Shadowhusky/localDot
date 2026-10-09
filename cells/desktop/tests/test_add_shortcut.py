import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

HELPER = Path(__file__).parent.parent / "root/defaults/localdot/add-shortcut.py"
spec = importlib.util.spec_from_file_location("add_shortcut", HELPER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

DEFAULTS = """<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-keyboard-shortcuts" version="1.0">
  <property name="commands" type="empty">
    <property name="default" type="empty">
      <property name="&lt;Alt&gt;F2" type="string" value="xfce4-appfinder --collapsed"/>
    </property>
  </property>
</channel>
"""

CLONED = """<?xml version="1.1" encoding="UTF-8"?>
<channel name="xfce4-keyboard-shortcuts" version="1.0">
  <property name="commands" type="empty">
    <property name="default" type="empty">
      <property name="&lt;Alt&gt;F2" type="empty"/>
    </property>
    <property name="custom" type="empty">
      <property name="&lt;Alt&gt;F2" type="string" value="xfce4-appfinder --collapsed"/>
      <property name="override" type="bool" value="true"/>
    </property>
  </property>
  <property name="xfwm4" type="empty">
    <property name="custom" type="empty">
      <property name="&lt;Super&gt;Tab" type="string" value="switch_window_key"/>
      <property name="override" type="bool" value="true"/>
    </property>
  </property>
</channel>
"""


def bindings(path, section):
    commands = next(p for p in ET.parse(path).getroot() if p.get("name") == "commands")
    group = next(p for p in commands if p.get("name") == section)
    return {p.get("name"): p.get("value") for p in group if p.get("name") != "override"}


class AddShortcutTest(unittest.TestCase):
    def write(self, text):
        path = Path(tempfile.mkdtemp(prefix="shortcuts-")) / "xfce4-keyboard-shortcuts.xml"
        path.write_text(text)
        return str(path)

    def test_defaults_gain_the_key_beside_the_others(self):
        path = self.write(DEFAULTS)
        m.main(path, "<Super>space", "localdot-spotlight")
        self.assertEqual(bindings(path, "default"), {
            "<Alt>F2": "xfce4-appfinder --collapsed",
            "<Super>space": "localdot-spotlight",
        })

    def test_a_cloned_home_gets_the_key_in_its_live_custom_set(self):
        path = self.write(CLONED)
        m.main(path, "<Super>space", "localdot-spotlight")
        self.assertEqual(bindings(path, "custom"), {
            "<Alt>F2": "xfce4-appfinder --collapsed",
            "<Super>space": "localdot-spotlight",
        })
        self.assertNotIn("<Super>space", bindings(path, "default"))

    def test_a_second_run_changes_nothing(self):
        path = self.write(CLONED)
        m.main(path, "<Super>space", "localdot-spotlight")
        first = Path(path).read_bytes()
        m.main(path, "<Super>space", "localdot-spotlight")
        self.assertEqual(Path(path).read_bytes(), first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
