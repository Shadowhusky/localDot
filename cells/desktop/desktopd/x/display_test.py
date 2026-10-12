"""Real Xvfb regression: idle capture must not become a healthy black stream.

Run inside the desktop image; a private X server leaves the user's display alone.
"""
import importlib.util
import os
import select
import shutil
import subprocess
import time
import unittest
from unittest.mock import patch


@unittest.skipUnless(shutil.which('Xvfb') and importlib.util.find_spec('Xlib'), 'requires desktop image')
class IdleDisplay(unittest.TestCase):
    def test_helper_wakes_a_blank_display_and_disables_idle_blanking(self):
        from Xlib import X, display
        from Xlib.ext import screensaver
        import xhelper

        # Let Xvfb allocate an unused display and report it through stdout.
        server = subprocess.Popen(
            ['Xvfb', '-displayfd', '1', '-screen', '0', '64x64x24', '-nolisten', 'tcp', '-noreset'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        connection = None
        try:
            self.assertTrue(select.select([server.stdout], [], [], 5)[0], 'Xvfb did not start')
            number = server.stdout.readline().decode().strip()
            connection = display.Display(':' + number)
            root = connection.screen().root
            # Reproduce the old default in seconds, without waiting ten minutes.
            connection.set_screen_saver(1, 1, X.PreferBlanking, X.AllowExposures)
            connection.force_screen_saver(X.ScreenSaverActive)
            connection.sync()
            self.assertEqual(root.screensaver_query_info().state, screensaver.StateOn)

            # Xvfb reports ScreenSaverDisabled (3); python-xlib only names states 0-2.
            with patch.dict(os.environ, {"DISPLAY": ":" + number}):
                helper = xhelper.Commands(xhelper.Screen())
                helper.d.close()
            self.assertIn(root.screensaver_query_info().state, (screensaver.StateOff, 3))
            settings = connection.get_screen_saver()
            self.assertEqual(settings.timeout, 0)
            self.assertEqual(settings.interval, 0)
            # No fake input, keepalive polling or periodic resets are needed.
            time.sleep(2)
            self.assertIn(root.screensaver_query_info().state, (screensaver.StateOff, 3))
        finally:
            if connection:
                connection.close()
            server.terminate()
            server.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
