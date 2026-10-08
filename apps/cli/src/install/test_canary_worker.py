"""Offline controls/transport fixtures. No Docker, clipboard, network or host memory scan."""

import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).parent
WORKER = load("worker", HERE / "canary-worker.py")
SCANNER = load("scanner", HERE.parents[2] / "daemon/src/keyd/testing/canary-scan.py")
MARKER = "control-" + "a" * 32
CLIPBOARD = "clipboard-" + "b" * 32
SURROGATE = "ld_key_" + "c" * 22 + "_" + "d" * 6
CHALLENGE = "e" * 32
ARGS = (MARKER, CLIPBOARD, SURROGATE, CHALLENGE)


def echo():
    return {"challenge": CHALLENGE, "authorization": "Bearer " + SURROGATE,
            "base64": base64.b64encode(SURROGATE.encode()).decode(),
            "hex": SURROGATE.encode().hex()}


class WorkerTests(unittest.TestCase):
    def transport(self, body=None, status=200, headers=None):
        connection = mock.Mock()
        response = connection.getresponse.return_value
        response.status = status
        response.getheaders.return_value = headers if headers is not None else [
            ("X-Canary-Key", SURROGATE), ("Content-Type", "application/json")]
        response.read.return_value = json.dumps(echo()).encode() if body is None else body
        return connection, response

    def request(self, connection):
        with mock.patch.object(WORKER.ssl, "create_default_context") as tls, \
                mock.patch.object(WORKER.http.client, "HTTPSConnection", return_value=connection) as ctor:
            result = WORKER.reflected_response(SURROGATE, CHALLENGE)
            tls.assert_called_once_with(cafile="/etc/ssl/certs/ca-certificates.crt")
            ctor.assert_called_once_with("127.0.0.1", 3129, timeout=8, context=tls.return_value)
            return result

    def test_reflection_uses_only_normal_proxy_trust_and_scrubbed_bytes(self):
        connection, response = self.transport()
        self.assertEqual(self.request(connection), json.dumps(echo()).encode())
        connection.set_tunnel.assert_called_once_with("canary.localdot.invalid", 443)
        connection.request.assert_called_once_with("GET", "/v1/canary/" + CHALLENGE, headers={
            "Host": "canary.localdot.invalid", "Authorization": "Bearer " + SURROGATE,
            "Connection": "close"})
        response.read.assert_called_once_with(65537)
        connection.close.assert_called_once()

    def test_unscrubbed_wrong_or_incomplete_reflections_are_rejected(self):
        cases = [b"{", b"\xff", b"x" * 65537, b"[]"]
        for field in echo():
            wrong = echo()
            wrong[field] = "unscrubbed-fake-upstream-value"
            cases.append(json.dumps(wrong).encode())
            missing = echo()
            del missing[field]
            cases.append(json.dumps(missing).encode())
        cases.append(json.dumps({**echo(), "extra": 1}).encode())
        cases.append(json.dumps(echo()).replace('"challenge":', '"challenge":"bad","challenge":').encode())
        for body in cases:
            with self.subTest(body=body[:60]):
                connection, _ = self.transport(body)
                with self.assertRaises((ValueError, UnicodeError)):
                    self.request(connection)
                connection.close.assert_called_once()

    def test_redirects_headers_and_transport_failure_never_fall_back(self):
        for status, headers in [
            (302, []), (407, []), (200, []),
            (200, [("X-Canary-Key", "raw"), ("Content-Type", "application/json")]),
            (200, [("X-Canary-Key", SURROGATE)] * 2 + [("Content-Type", "application/json")]),
        ]:
            connection, _ = self.transport(status=status, headers=headers)
            with self.assertRaises(ValueError):
                self.request(connection)
            connection.close.assert_called_once()
        connection, _ = self.transport()
        connection.request.side_effect = OSError("fixture")
        with self.assertRaises(OSError):
            self.request(connection)
        connection.close.assert_called_once()

    def test_all_ten_file_controls_are_found_by_canonical_scanner(self):
        with tempfile.TemporaryDirectory() as root:
            directory = root + "/controls"
            files = WORKER.write_controls(directory, MARKER, b"scrubbed fixture")
            patterns = [(MARKER, label, pattern) for label, pattern in SCANNER.forms(MARKER.encode())]
            found = set()
            count, size, errors = SCANNER.scan_files([directory], patterns, found)
            self.assertEqual(count, 11)
            self.assertGreater(size, 0)
            self.assertEqual(errors, [])
            self.assertEqual(len(files), 10)
            self.assertEqual({item["form"] for item in files}, {item[1] for item in patterns})
            for item in files:
                self.assertIn((MARKER, item["form"], "file " + item["path"]), found)
                self.assertEqual(os.stat(item["path"]).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError):
                WORKER.write_controls(directory, MARKER, b"overwritten")
            self.assertEqual(Path(directory, "reflection.json").read_bytes(), b"scrubbed fixture")

    def test_existing_link_is_not_followed(self):
        with tempfile.TemporaryDirectory() as root:
            link = Path(root, "link")
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(FileExistsError):
                WORKER.write_controls(str(link), MARKER, b"fixture")
            self.assertEqual(sorted(path.name for path in Path(root).iterdir()), ["link"])

    def test_invalid_inputs_fail_before_effects(self):
        for index in range(4):
            for value in ("", "../escape", "value\n", "a" * 1000):
                args = list(ARGS)
                args[index] = value
                with mock.patch.object(WORKER, "reflected_response") as network:
                    with self.assertRaises(ValueError):
                        WORKER.exercise(*args)
                    network.assert_not_called()

    def test_holder_argv_environment_and_pipe_ownership(self):
        with mock.patch.object(WORKER.subprocess, "Popen") as spawn:
            WORKER.start_holder(MARKER, SURROGATE)
        args, kwargs = spawn.call_args
        self.assertEqual(args, ([MARKER, "540"],))
        self.assertEqual(kwargs["executable"], "/bin/sleep")
        self.assertEqual(kwargs["env"], {**WORKER.CHILD_ENV,
                                          "LOCALDOT_MARKER": MARKER, "LOCALDOT_SURROGATE": SURROGATE})
        for pipe in ("stdin", "stdout", "stderr"):
            self.assertEqual(kwargs[pipe], WORKER.subprocess.DEVNULL)
        self.assertTrue(kwargs["close_fds"])

    def test_success_retains_controls_failure_reaps_known_children(self):
        holder, clipboard = mock.Mock(), mock.Mock()
        holder.poll.return_value = clipboard.poll.return_value = None
        with mock.patch.object(WORKER, "reflected_response", return_value=b"reflection"), \
                mock.patch.object(WORKER, "write_controls", return_value=[{"form": "fixture"}]), \
                mock.patch.object(WORKER, "start_holder", return_value=holder), \
                mock.patch.object(WORKER, "start_clipboard", return_value=clipboard) as start:
            result = WORKER.exercise(*ARGS)
            self.assertEqual(result, {"v": 1, "type": "exercised", "challenge": CHALLENGE,
                                      "files": [{"form": "fixture"}]})
            start.assert_called_with(b"reflection\n" + CLIPBOARD.encode())
            holder.kill.assert_not_called()
            clipboard.kill.assert_not_called()
            clipboard.poll.return_value = 1
            with self.assertRaises(ValueError):
                WORKER.exercise(*ARGS)
            holder.kill.assert_called_once()
            holder.wait.assert_called_once_with(timeout=3)
            clipboard.wait.assert_called_once_with(timeout=3)

    def test_clipboard_readback_must_match_and_owner_must_live(self):
        child = mock.Mock(stdin=io.BytesIO())
        child.poll.return_value = None
        with mock.patch.object(WORKER.subprocess, "Popen", return_value=child), \
                mock.patch.object(WORKER, "read_clipboard", side_effect=[b"wrong", b"payload"]) as read, \
                mock.patch.object(WORKER.time, "sleep"):
            self.assertIs(WORKER.start_clipboard(b"payload"), child)
            self.assertEqual(read.call_count, 2)
            child.kill.assert_not_called()
        child = mock.Mock(stdin=io.BytesIO())
        child.poll.return_value = 1
        with mock.patch.object(WORKER.subprocess, "Popen", return_value=child):
            with self.assertRaises(ValueError):
                WORKER.start_clipboard(b"payload")
            child.wait.assert_called_once_with(timeout=3)

    def test_bounded_clipboard_read_and_failure_drain_with_pipe_fixture(self):
        for data, expected in [(b"payload", b"payload"), (b"", b"")]:
            read, write = os.pipe()
            os.write(write, data)
            os.close(write)
            child = mock.Mock(stdout=os.fdopen(read, "rb"))
            child.wait.return_value = 0
            child.poll.return_value = 0
            with mock.patch.object(WORKER.subprocess, "Popen", return_value=child):
                self.assertEqual(WORKER.read_clipboard(), expected)
                self.assertTrue(child.stdout.closed)
                self.assertEqual(child.wait.call_count, 2)
        child = mock.Mock()
        child.poll.return_value = None
        with mock.patch.object(WORKER.subprocess, "Popen", return_value=child), \
                mock.patch.object(WORKER.selectors, "DefaultSelector") as select, \
                mock.patch.object(WORKER.os, "read", return_value=b"x" * (WORKER.MAX_BODY + 129)):
            select.return_value.__enter__.return_value.select.return_value = [True]
            with self.assertRaises(ValueError):
                WORKER.read_clipboard()
            child.kill.assert_called_once()
            child.wait.assert_called_once_with(timeout=3)
            child.stdout.close.assert_called_once()

    def test_mount_coverage_preserves_escaped_names_excludes_kernel_trees(self):
        mounts = "\n".join("tmpfs " + path + " tmpfs rw 0 0" for path in (
            "/dev", "/dev/shm", "/run", "/tmp/a\\040b", "/tmp/new\\012line",
            "/proc/interrupts", "/sys/firmware")) + "\noverlay / overlay rw 0 0"
        self.assertEqual(WORKER.tmpfs_roots(mounts), [
            "/config", "/dev", "/dev/shm", "/run", "/tmp/a b", "/tmp/new\nline"])
        for path in ("/", "relative", "/tmp/../x", "/tmp//x", "/tmp/\\000"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                WORKER.tmpfs_roots("tmpfs " + path + " tmpfs rw 0 0")
        with self.assertRaises(ValueError):
            WORKER.tmpfs_roots("malformed")
        with self.assertRaises(ValueError):
            WORKER.tmpfs_roots("x" * (1024 * 1024 + 1))

    def test_main_refuses_host_and_unknown_modes_without_effects(self):
        with mock.patch.object(WORKER.sys, "platform", "darwin"), \
                mock.patch.object(WORKER, "exercise") as run:
            with self.assertRaises(ValueError):
                WORKER.main(["exercise", *ARGS])
            run.assert_not_called()
        with mock.patch.object(WORKER.sys, "platform", "linux"), \
                mock.patch.object(WORKER.os.path, "isfile", return_value=True), \
                mock.patch.object(WORKER.signal, "signal"), mock.patch.object(WORKER.signal, "alarm") as alarm:
            with self.assertRaises(ValueError):
                WORKER.main(["shell", "anything"])
            self.assertEqual(alarm.call_args_list, [mock.call(30), mock.call(0)])


if __name__ == "__main__":
    unittest.main()
