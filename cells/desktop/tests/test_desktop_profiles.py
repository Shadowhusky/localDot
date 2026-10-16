import concurrent.futures
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).parent
HELPER = HERE.parent / "desktopd/desktop-browser.py"
WORKER = HERE / "profile-worker.py"
spec = importlib.util.spec_from_file_location("desktop_profiles", HELPER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
A = "01J" + "0" * 22 + "1"
B = "01J" + "0" * 22 + "2"


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="desktop-profiles-"))
        self.root = self.home / "profiles"
        self.root.mkdir(mode=0o700)
        self.owner = m.Profiles(str(self.root))
        self.processes = []
        self.groups = []

    def tearDown(self):
        for group in self.groups:
            with contextlib.suppress(Exception):
                m.retire(group)
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)
        shutil.rmtree(self.home)

    def state(self):
        return json.loads((self.root / "state.json").read_text())

    def profile(self):
        return self.root / ("profile-" + self.state()["generation"])

    def wait(self, predicate):
        deadline = time.monotonic() + 4
        while not predicate():
            self.assertLess(time.monotonic(), deadline, "synthetic browser did not settle")
            time.sleep(0.01)

    def launch(self, mode="foreground"):
        code = "import importlib.util,sys; s=importlib.util.spec_from_file_location('p',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.exit(m.Profiles(sys.argv[2]).launch(['about:blank'], (sys.executable,sys.argv[3])))"
        process = subprocess.Popen([sys.executable, "-c", code, str(HELPER), str(self.root), str(WORKER)],
            env={**os.environ, "LOCALDOT_PROFILE_TEST_MODE": mode, "LOCALDOT_DESKTOPD_TOKEN": "private-fixture"},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        self.wait(lambda: (self.profile() / "ready.json").exists())
        self.groups.extend(g for g in self.state()["groups"] if g not in self.groups)
        return process, json.loads((self.profile() / "ready.json").read_text())

    def test_next_task_forgets_cookie_without_touching_signed_in_profile(self):
        persistent = self.home / "signed-in"
        persistent.mkdir()
        (persistent / "Cookies").write_text("isolated-login")
        first = self.owner.rotate(A)
        old = self.profile()
        (old / "Cookies").write_text("desktop-login")
        second = self.owner.rotate(B)
        self.assertNotEqual(first["generation"], second["generation"])
        self.assertFalse(old.exists())
        self.assertFalse((self.profile() / "Cookies").exists())
        self.assertEqual((persistent / "Cookies").read_text(), "isolated-login")

    def test_new_profile_draws_its_frame_from_the_gtk_theme(self):
        self.owner.rotate(A)
        preferences = json.loads((self.profile() / "Default" / "Preferences").read_text())
        self.assertIs(preferences["browser"]["custom_chrome_frame"], True)
        self.assertEqual(preferences["extensions"]["theme"]["system_theme"], 1)
        self.owner.rotate(B)
        self.assertTrue((self.profile() / "Default" / "Preferences").exists())

    def test_same_task_retry_keeps_current_cookie(self):
        first = self.owner.rotate(A)
        (self.profile() / "Cookies").write_text("current-task")
        self.assertEqual(self.owner.rotate(A), first)
        self.assertEqual((self.profile() / "Cookies").read_text(), "current-task")

    def test_live_browser_retires_before_replacement(self):
        self.owner.rotate(A)
        old = self.profile()
        process, ready = self.launch()
        self.assertFalse(ready["secretInherited"])
        self.assertIn("--user-data-dir=" + str(old), ready["args"])
        self.assertIn("--allow-insecure-localhost", ready["args"])
        self.assertIn("--use-gl=angle", ready["args"])
        self.assertIn("--use-angle=gl", ready["args"])
        self.assertIn("--ignore-gpu-blocklist", ready["args"])
        self.assertNotIn("--disable-gpu-sandbox", ready["args"])
        self.assertNotIn("--ignore-certificate-errors", ready["args"])
        self.owner.rotate(B)
        self.assertFalse(old.exists())
        self.assertFalse(m.members(self.groups[0]))
        process.wait(timeout=3)

    def test_recovery_kills_child_after_browser_and_launcher_exit(self):
        self.owner.rotate(A)
        old = self.profile()
        process, ready = self.launch("survivor")
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertNotEqual(ready["pid"], self.groups[0]["pid"])
        self.assertTrue(m.members(self.groups[0]))
        result = self.owner.rotate(None, recover=True)
        self.assertIsNone(result["taskId"])
        self.assertFalse(old.exists())
        self.assertFalse(m.members(self.groups[0]))

    def test_crashed_launcher_does_not_make_profile_reusable(self):
        self.owner.rotate(A)
        old = self.profile()
        process, _ = self.launch()
        process.kill()
        process.wait(timeout=3)
        self.assertTrue(m.members(self.groups[0]))
        self.owner.rotate(None, recover=True)
        self.assertFalse(m.members(self.groups[0]))
        self.assertFalse(old.exists())

    def test_concurrent_same_task_requests_admit_one_generation(self):
        self.owner.rotate(A)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.owner.rotate(B), range(6)))
        self.assertEqual(len({r["generation"] for r in results}), 1)
        self.assertEqual(len(list(self.root.glob("profile-*"))), 1)

    def test_launch_during_retirement_waits_for_the_new_profile(self):
        self.owner.rotate(A)
        old = self.profile()
        entered, release = threading.Event(), threading.Event()
        remove = self.owner.remove
        def held_remove(root, value):
            entered.set()
            self.assertTrue(release.wait(3))
            remove(root, value)
        self.owner.remove = held_remove
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rotation = pool.submit(self.owner.rotate, B)
            self.assertTrue(entered.wait(3))
            launching = pool.submit(self.launch)
            try:
                self.assertEqual(self.state()["phase"], "retiring")
                self.assertFalse((old / "ready.json").exists())
            finally:
                release.set()
            rotation.result(timeout=3)
            _, ready = launching.result(timeout=4)
        self.assertFalse(old.exists())
        self.assertIn("--user-data-dir=" + str(self.profile()), ready["args"])

    def test_symlinks_do_not_delete_files_outside_profile(self):
        self.owner.rotate(A)
        outside = self.home / "outside"
        outside.mkdir()
        (outside / "canary").write_text("keep")
        (self.profile() / "nested").symlink_to(outside, target_is_directory=True)
        (self.profile() / "SingletonSocket").symlink_to("/tmp/not-owned-socket")
        self.owner.rotate(B)
        self.assertEqual((outside / "canary").read_text(), "keep")

    def test_swapped_profile_is_not_deleted_or_reused(self):
        self.owner.rotate(A)
        old = self.profile()
        old.rename(self.home / "original")
        old.mkdir(mode=0o700)
        (old / "foreign").write_text("keep")
        with self.assertRaises(m.Refused):
            self.owner.rotate(B)
        self.assertEqual((old / "foreign").read_text(), "keep")
        self.assertEqual(self.state()["phase"], "retiring")
        with self.assertRaises(m.Refused):
            self.owner.launch(["about:blank"])

    def test_root_symlink_is_refused(self):
        linked = self.home / "alias"
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            m.Profiles(str(linked)).rotate(A)

    def test_state_hardlink_and_forged_path_are_refused(self):
        self.owner.rotate(A)
        os.link(self.root / "state.json", self.home / "linked")
        with self.assertRaises(m.Refused):
            self.owner.rotate(B)
        (self.home / "linked").unlink()
        value = self.state()
        value["generation"] = "../../signed-in"
        (self.root / "state.json").write_text(json.dumps(value))
        with self.assertRaises(m.Refused):
            self.owner.rotate(B)

    def test_reused_pid_does_not_signal_an_unrelated_process(self):
        self.owner.rotate(A)
        value = self.state()
        value["groups"] = [{"pid": os.getpid(), "start": m.proc(os.getpid())["start"] - 1}]
        with self.owner.locked() as root:
            self.owner.write(root, value)
        with self.assertRaises(m.Refused):
            self.owner.rotate(B)
        self.assertEqual(self.state()["phase"], "retiring")

    def test_interrupted_deletion_finishes_before_new_task(self):
        self.owner.rotate(A)
        value = self.state()
        value["phase"] = "retiring"
        with self.owner.locked() as root:
            self.owner.write(root, value)
            self.owner.remove(root, value)
        self.assertEqual(self.owner.rotate(B)["taskId"], B)

    def test_launch_cannot_override_profile_or_debugging_endpoint(self):
        self.owner.rotate(A)
        for arg in ["--user-data-dir=/config/private", "--remote-debugging-port=9333", "--load-extension=/config/ext", "--proxy-server=http://wrong", "https://example.test/\n--flag"]:
            with self.subTest(arg=arg), self.assertRaises(m.Refused):
                self.owner.launch([arg])



class StartPageTest(unittest.TestCase):
    def test_a_window_without_a_page_opens_on_the_notice(self):
        self.assertEqual(m.with_start_page([]), [m.NOTICE])
        self.assertEqual(m.with_start_page(["--new-window"]), ["--new-window", m.NOTICE])

    def test_a_page_asked_for_opens_as_asked(self):
        self.assertEqual(m.with_start_page(["about:blank"]), ["about:blank"])
        self.assertEqual(m.with_start_page(["--new-window", "https://example.com/"]),
                         ["--new-window", "https://example.com/"])
        self.assertEqual(m.with_start_page(["/config/Downloads/page.html"]),
                         ["/config/Downloads/page.html"])

    def test_the_notice_passes_the_launch_rules(self):
        self.assertTrue(m.NOTICE.startswith("file:///opt/localdot/"))
        root = Path(__file__).parent.parent / "root"
        self.assertTrue((root / m.NOTICE.removeprefix("file:///")).is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
