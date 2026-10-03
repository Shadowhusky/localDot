"""Local scanner acceptance: temporary files only, never host process memory.

Run: python3 apps/daemon/src/keyd/testing/test_canary_scan.py
The Docker suite separately proves Linux process/memory coverage and keyd behavior.
"""

import base64
from contextlib import contextmanager
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCANNER_PATH = Path(__file__).with_name("canary-scan.py")
SPEC = importlib.util.spec_from_file_location("canary_scan", SCANNER_PATH)
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)

NEEDLE = "scanner-control-???-0123456789-abcdef"
RAW = NEEDLE.encode()
PATTERNS = [(NEEDLE, label, value) for label, value in scanner.forms(RAW)]


@contextmanager
def bounded(seconds):
    """A broken FIFO traversal or large-file loop must fail instead of hanging."""
    def expired(_signal, _frame):
        raise AssertionError(f"scanner operation exceeded {seconds} seconds")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class CanaryScanTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="localdot-scanner-unit-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def stream(self, payload, chunk=7, patterns=PATTERNS):
        source = io.BytesIO(payload)
        found = set()
        size = scanner.scan_stream(lambda: source.read(chunk), patterns, found, "fixture")
        self.assertEqual(size, len(payload))
        return found

    def scan_files(self, roots, patterns=PATTERNS):
        found = set()
        with bounded(30):
            count, size, errors = scanner.scan_files([str(root) for root in roots], patterns, found)
        return count, size, errors, found

    def cli(self, *arguments):
        # Every invocation explicitly disables process scans. All paths are under
        # this test's /tmp fixture, and subprocess output/time are bounded.
        return subprocess.run(
            [sys.executable, str(SCANNER_PATH), *arguments, "--no-processes"],
            cwd=self.root, capture_output=True, text=True, timeout=30, check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_every_form_has_a_positive_control_and_unrelated_text_is_negative(self):
        expected = {
            "raw": RAW,
            "base64": base64.b64encode(RAW),
            "base64url": base64.urlsafe_b64encode(RAW),
            "hex": RAW.hex().encode(),
            "HEX": RAW.hex().upper().encode(),
            "utf16le": NEEDLE.encode("utf-16-le"),
        }
        self.assertNotEqual(expected["base64"], expected["base64url"])
        labels = {label for _, label, _ in PATTERNS}
        self.assertEqual(labels, set(expected) | {"base64+1", "base64+2", "base64url+1", "base64url+2"})
        self.assertTrue(all(value for _, _, value in PATTERNS))
        for label, encoded in expected.items():
            with self.subTest(label=label):
                self.assertIn((NEEDLE, label, "fixture"), self.stream(encoded))
        self.assertEqual(self.stream(b"unrelated ordinary contents\0" * 8), set())
        self.assertEqual(self.stream(b""), set())

    def test_embedded_base64_at_every_offset_with_arbitrary_adjacent_bytes(self):
        for label, encode in (("base64", base64.b64encode), ("base64url", base64.urlsafe_b64encode)):
            for offset in range(3):
                for neighbors in (b"\0\x80\xff", b"\xfe\x01\x7f", b"xyz"):
                    # Include a complete unrelated triplet as well as the partial
                    # group, so offset zero is tested inside a longer blob too.
                    prefix = neighbors + neighbors[:offset]
                    suffix = neighbors[::-1] + b"tail"
                    payload = encode(prefix + RAW + suffix)
                    expected_label = label + (f"+{offset}" if offset else "")
                    with self.subTest(label=label, offset=offset, neighbors=neighbors):
                        self.assertIn((NEEDLE, expected_label, "fixture"), self.stream(payload, chunk=11))

    def test_matches_spanning_small_stream_and_file_chunks_are_not_lost(self):
        payload = b"x" * 6 + RAW + b"y" * 15
        # The pattern spans many chunks, not just a single adjacent boundary.
        self.assertIn((NEEDLE, "raw", "fixture"), self.stream(payload, chunk=7))
        path = self.root / "chunked.bin"
        path.write_bytes(payload)
        with mock.patch.object(scanner, "CHUNK", 7):
            count, size, errors, found = self.scan_files([path])
        self.assertEqual((count, size, errors), (1, len(payload), []))
        self.assertIn((NEEDLE, "raw", "file " + str(path)), found)

    def test_short_and_empty_needles_are_rejected_by_cli(self):
        for needle in ("", "short", "x" * 11):
            with self.subTest(needle=needle):
                result = self.cli(needle, "--files", str(self.root))
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("at least 12 UTF-8 bytes", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_cli_file_scan_reports_real_positive_coverage_and_never_scans_processes(self):
        path = self.root / "known-positive"
        path.write_bytes(RAW)
        result = self.cli(NEEDLE, "--files", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report["processes"], report["bytes"], report["unreadableMemory"]), (0, 0, 0))
        self.assertEqual((report["memoryHits"], report["memoryReads"], report["processErrors"]), ([], [], []))
        self.assertEqual((report["files"], report["fileBytes"], report["fileErrors"]), (1, len(RAW), []))
        self.assertIn(f"{NEEDLE}|raw|file {path}", report["hits"])

    def test_overlapping_roots_and_hardlinks_do_not_inflate_actual_file_coverage(self):
        nested = self.root / "nested"
        nested.mkdir()
        positive = nested / "positive"
        positive.write_bytes(RAW)
        duplicate = self.root / "same-inode"
        os.link(positive, duplicate)
        ordinary = self.root / "ordinary"
        ordinary.write_bytes(b"ordinary")
        roots = [positive, nested, self.root, duplicate, self.root]
        count, size, errors, found = self.scan_files(roots)
        self.assertEqual((count, size, errors), (2, len(RAW) + len(b"ordinary"), []))
        self.assertIn((NEEDLE, "raw", "file " + str(positive)), found)
        self.assertEqual(len([hit for hit in found if hit[1] == "raw"]), 1)

    def test_symlink_files_symlink_directories_and_fifo_are_skipped_without_hanging(self):
        inspected = self.root / "inspected"
        outside = self.root / "outside"
        inspected.mkdir()
        outside.mkdir()
        secret = outside / "must-not-follow"
        secret.write_bytes(RAW)
        file_link = inspected / "file-link"
        directory_link = inspected / "directory-link"
        file_link.symlink_to(secret)
        directory_link.symlink_to(outside, target_is_directory=True)
        os.mkfifo(inspected / "fifo")
        ordinary = inspected / "ordinary"
        ordinary.write_bytes(b"known real file")
        with bounded(3):
            found = set()
            count, size, errors = scanner.scan_files(
                [str(file_link), str(directory_link), str(inspected)], PATTERNS, found,
            )
        self.assertEqual((count, size, errors), (1, len(b"known real file"), []))
        self.assertEqual(found, set())

    def test_file_read_error_is_reported_and_cannot_count_as_coverage(self):
        bad = self.root / "unreadable"
        good = self.root / "positive"
        bad.write_bytes(RAW)
        good.write_bytes(RAW)
        real_open = scanner.os.open

        def fail_bad(path, flags):
            if str(path) == str(bad):
                raise PermissionError(errno.EACCES, "Permission denied", str(path))
            return real_open(path, flags)

        with mock.patch.object(scanner.os, "open", side_effect=fail_bad):
            count, size, errors, found = self.scan_files([bad, good])
        self.assertEqual((count, size), (1, len(RAW)))
        self.assertEqual(errors, [f"{bad}: Permission denied"])
        self.assertIn((NEEDLE, "raw", "file " + str(good)), found)
        self.assertNotIn((NEEDLE, "raw", "file " + str(bad)), found)

    def test_sparse_file_over_256_mib_is_scanned_through_the_near_end_canary(self):
        path = self.root / "large-sparse.bin"
        offset = 257 * 1024 * 1024 - len(RAW) - 17
        with path.open("wb") as source:
            source.seek(offset)
            source.write(RAW + b"trailing-bytes-123")
        size = path.stat().st_size
        self.assertGreater(size, 256 * 1024 * 1024)
        count, read_size, errors, found = self.scan_files([path], [(NEEDLE, "raw", RAW)])
        self.assertEqual((count, read_size, errors), (1, size, []))
        self.assertIn((NEEDLE, "raw", "file " + str(path)), found)


    def process_fixture(self, root, pid, comm="sleep", payload=RAW, maps=None):
        directory = root / str(pid)
        directory.mkdir(parents=True)
        (directory / "comm").write_text(comm + "\n")
        (directory / "environ").write_bytes(b"EMPTY=1\0")
        (directory / "cmdline").write_bytes(comm.encode() + b"\0")
        (directory / "mem").write_bytes(payload)
        (directory / "maps").write_text(
            maps if maps is not None else f"0000-{len(payload):04x} r--p 0000 00:00 0\n"
        )
        return directory

    def process_scan(self, root, patterns=PATTERNS):
        # Explicit fake proc root and fake own PID: no host /proc or memory reads.
        found = set()
        with mock.patch.object(scanner.os, "getpid", return_value=999):
            result = scanner.scan_processes(patterns, found, proc_root=str(root))
        return result, found

    def test_memory_evidence_names_the_process_and_skips_self_and_kernel_pseudomaps(self):
        proc = self.root / "proc"
        clipboard = "clipboard-only-control-0123456789"
        payload = clipboard.encode() * 2
        self.process_fixture(proc, 101, "sleep")
        self.process_fixture(proc, 102, "xclip", payload, maps=(
            f"0000-{len(payload):04x} r--p 0000 00:00 0\n"
            "1000-2000 r--p 0000 00:00 0 [vvar]\n"
            "2000-3000 r--p 0000 00:00 0 [vvar_vclock]\n"
            "3000-4000 r-xp 0000 00:00 0 [vsyscall]\n"
            "4000-5000 --xp 0000 00:00 0\n"
        ))
        self.process_fixture(proc, 999, "scanner", RAW * 5)
        (proc / "not-a-pid").mkdir()
        patterns = [(NEEDLE, "raw", RAW), (clipboard, "raw", clipboard.encode())]
        result, found = self.process_scan(proc, patterns)
        processes, size, unreadable, hits, reads, errors = result
        self.assertEqual((processes, size, unreadable, errors), (2, len(RAW) + len(payload), 0, []))
        self.assertEqual(hits, [
            {"pid": 101, "comm": "sleep", "needle": NEEDLE, "form": "raw"},
            {"pid": 102, "comm": "xclip", "needle": clipboard, "form": "raw"},
        ])
        self.assertEqual(reads, [
            {"pid": 101, "comm": "sleep", "bytes": len(RAW)},
            {"pid": 102, "comm": "xclip", "bytes": len(payload)},
        ])
        self.assertEqual(found, {(NEEDLE, "raw", "memory"), (clipboard, "raw", "memory")})

    def test_generic_memory_hit_cannot_claim_an_unreadable_clipboard_process(self):
        proc = self.root / "proc"
        self.process_fixture(proc, 101, "sleep")
        xclip = self.process_fixture(proc, 102, "xclip")
        real_open = open

        def deny_xclip(path, *args, **kwargs):
            if str(path) == str(xclip / "mem"):
                raise PermissionError(errno.EACCES, "Permission denied")
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=deny_xclip):
            result, found = self.process_scan(proc, [(NEEDLE, "raw", RAW)])
        processes, size, unreadable, hits, reads, errors = result
        self.assertIn((NEEDLE, "raw", "memory"), found)
        self.assertEqual((processes, size, unreadable), (1, len(RAW), 1))
        self.assertEqual(hits, [{"pid": 101, "comm": "sleep", "needle": NEEDLE, "form": "raw"}])
        self.assertEqual(reads[-1], {"pid": 102, "comm": "xclip", "bytes": 0})
        self.assertEqual(errors, [{
            "pid": 102, "comm": "xclip", "surface": "memory", "errno": errno.EACCES, "vanished": False,
        }])

    def test_permission_failures_name_each_process_surface_and_keep_readable_evidence(self):
        for surface, filename in (("comm", "comm"), ("environ", "environ"), ("cmdline", "cmdline"), ("maps", "maps"), ("memory", "mem")):
            with self.subTest(surface=surface):
                proc = self.root / surface
                process = self.process_fixture(proc, 101, "xclip")
                real_open = open

                def deny_surface(path, *args, **kwargs):
                    if str(path) == str(process / filename):
                        raise PermissionError(errno.EPERM, "Operation not permitted")
                    return real_open(path, *args, **kwargs)

                with mock.patch("builtins.open", side_effect=deny_surface):
                    result, found = self.process_scan(proc, [(NEEDLE, "raw", RAW)])
                processes, size, unreadable, hits, reads, errors = result
                comm = "" if surface == "comm" else "xclip"
                expected_bytes = 0 if surface in ("maps", "memory") else len(RAW)
                self.assertEqual((processes, size, unreadable), (int(expected_bytes > 0), expected_bytes, int(surface in ("maps", "memory"))))
                self.assertEqual(errors, [{
                    "pid": 101, "comm": comm, "surface": surface, "errno": errno.EPERM, "vanished": False,
                }])
                self.assertEqual(reads, [{"pid": 101, "comm": comm, "bytes": expected_bytes}])
                self.assertEqual(len(hits), int(expected_bytes > 0))
                self.assertEqual((NEEDLE, "raw", "memory") in found, expected_bytes > 0)

    def test_exited_process_is_distinguished_from_a_missing_surface_on_a_live_process(self):
        for vanishes in (False, True):
            with self.subTest(vanishes=vanishes):
                proc = self.root / str(vanishes)
                process = self.process_fixture(proc, 101, "xclip")
                real_open = open

                def disappears(path, *args, **kwargs):
                    if str(path) == str(process / "environ"):
                        if vanishes:
                            shutil.rmtree(process)
                        raise FileNotFoundError(errno.ENOENT, "No such file")
                    return real_open(path, *args, **kwargs)

                with mock.patch("builtins.open", side_effect=disappears):
                    result, _ = self.process_scan(proc)
                processes, size, unreadable, _, reads, errors = result
                self.assertTrue(errors, "a missing process surface must be reported")
                self.assertEqual(errors[0], {
                    "pid": 101, "comm": "xclip", "surface": "environ", "errno": errno.ENOENT, "vanished": vanishes,
                })
                self.assertTrue(all(error["vanished"] == vanishes for error in errors))
                if vanishes:
                    self.assertEqual([error["surface"] for error in errors], ["environ", "cmdline", "maps"])
                    self.assertEqual((processes, size, unreadable, reads[0]["bytes"]), (0, 0, 1, 0))
                else:
                    self.assertEqual(len(errors), 1)
                    self.assertEqual((processes, size, unreadable), (1, len(RAW), 0))

    def test_unreadable_mapping_does_not_hide_later_maps_or_inflate_byte_coverage(self):
        proc = self.root / "proc"
        later = "later-memory-control-0123456789"
        later_raw = later.encode()
        payload = RAW + b"x" * (128 - len(RAW)) + later_raw
        process = self.process_fixture(proc, 101, "xclip", payload, maps=(
            f"0000-{len(RAW):04x} r--p 0000 00:00 0\n"
            "0040-0050 r--p 0000 00:00 0\n"
            f"0080-{128 + len(later_raw):04x} r--p 0000 00:00 0\n"
        ))
        real_open = open

        class UnreadableMap(io.BytesIO):
            def seek(self, offset, *args):
                if offset == 64:
                    raise OSError(errno.EIO, "Input/output error")
                return super().seek(offset, *args)

        def memory_gap(path, *args, **kwargs):
            if str(path) == str(process / "mem"):
                return UnreadableMap(payload)
            return real_open(path, *args, **kwargs)

        patterns = [(NEEDLE, "raw", RAW), (later, "raw", later_raw)]
        with mock.patch("builtins.open", side_effect=memory_gap):
            result, found = self.process_scan(proc, patterns)
        processes, size, unreadable, hits, reads, errors = result
        expected_bytes = len(RAW) + len(later_raw)
        self.assertEqual((processes, size, unreadable), (1, expected_bytes, 1))
        self.assertEqual(reads, [{"pid": 101, "comm": "xclip", "bytes": expected_bytes}])
        self.assertEqual({hit["needle"] for hit in hits}, {NEEDLE, later})
        self.assertEqual(found, {(NEEDLE, "raw", "memory"), (later, "raw", "memory")})
        self.assertEqual(errors, [{
            "pid": 101, "comm": "xclip", "surface": "memory", "errno": errno.EIO,
            "vanished": False, "mapping": "0040-0050",
        }])

    def test_premature_memory_eof_reports_a_gap_and_counts_only_the_read_prefix(self):
        proc = self.root / "proc"
        self.process_fixture(proc, 101, "xclip", RAW, maps=f"0000-{len(RAW) + 20:04x} r--p 0000 00:00 0\n")
        result, found = self.process_scan(proc, [(NEEDLE, "raw", RAW)])
        processes, size, unreadable, hits, reads, errors = result
        self.assertEqual((processes, size, unreadable), (1, len(RAW), 1))
        self.assertEqual(reads, [{"pid": 101, "comm": "xclip", "bytes": len(RAW)}])
        self.assertEqual(hits, [{"pid": 101, "comm": "xclip", "needle": NEEDLE, "form": "raw"}])
        self.assertEqual(found, {(NEEDLE, "raw", "memory")})
        self.assertEqual(errors, [{
            "pid": 101, "comm": "xclip", "surface": "memory", "errno": errno.EIO,
            "vanished": False, "mapping": f"0000-{len(RAW) + 20:04x}",
        }])


if __name__ == "__main__":
    unittest.main(verbosity=2)
