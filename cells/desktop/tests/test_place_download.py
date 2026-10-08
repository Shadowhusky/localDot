import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


HELPER = Path(__file__).resolve().parents[1] / "desktopd" / "place-download.py"
SPEC = importlib.util.spec_from_file_location("placement", HELPER)
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


def ident():
    return "0" + uuid.uuid4().hex[:25].upper()


@unittest.skipUnless(sys.platform == "linux", "production descriptor-relative delivery requires Linux")
class Placement(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="localdot-placement-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.bytes = b"approved archive bytes\x00\xff"
        self.request = dict(transferId=ident(), parentCellId=ident(), name="report.zip",
                            bytes=len(self.bytes), sha256=hashlib.sha256(self.bytes).hexdigest())

    @contextlib.contextmanager
    def owner(self, request=None, reconcile=False):
        owner = p.Delivery.__new__(p.Delivery)
        owner.fds = []
        try:
            owner.__init__(str(self.home), request or self.request, reconcile)
            yield owner
        finally:
            owner.close()

    def publish(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            return owner.commit(fd)

    def path(self, receipt):
        return self.home / receipt["path"][2:]

    def command(self, data=None, request=None, reconcile=False, commit=b"C"):
        header = dict(version=1, request=request or self.request, reconcileOnly=reconcile)
        wire = json.dumps(header).encode() + b"\n" + (self.bytes if data is None else data) + commit
        result = subprocess.run([sys.executable, "-I", "-B", str(HELPER), "--home", str(self.home)],
                                input=wire, capture_output=True, timeout=10)
        self.assertEqual(result.stderr, b"")
        return result.returncode, [json.loads(line) for line in result.stdout.splitlines()]

    def assertNoVisibleFiles(self):
        if (self.home / "Downloads").exists():
            self.assertEqual(list((self.home / "Downloads").iterdir()), [])

    def test_exact_bytes_nonexecuting_private_receipt(self):
        result = self.publish()
        self.assertEqual(result, dict(self.request, path="~/Downloads/report.zip"))
        target = self.path(result)
        self.assertEqual(target.read_bytes(), self.bytes)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        folder = self.home / ".localdot-downloads" / self.request["transferId"]
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((folder / "record.json").stat().st_mode), 0o600)
        self.assertEqual(sorted(x.name for x in folder.iterdir()), ["record.json"])
        self.assertEqual(sorted(x.name for x in (self.home / "Downloads").iterdir()), ["report.zip"])

    def test_collision_preserves_existing_file_and_extension(self):
        downloads = self.home / "Downloads"
        downloads.mkdir()
        (downloads / "report.zip").write_bytes(b"existing")
        (downloads / "report (1).zip").write_bytes(b"also existing")
        result = self.publish()
        self.assertEqual(result["path"], "~/Downloads/report (2).zip")
        self.assertEqual((downloads / "report.zip").read_bytes(), b"existing")
        self.assertEqual((downloads / "report (1).zip").read_bytes(), b"also existing")
        self.assertEqual(self.path(result).read_bytes(), self.bytes)

    def test_destination_symlink_is_a_collision_never_followed(self):
        outside = self.home / "outside"
        outside.write_bytes(b"leave untouched")
        downloads = self.home / "Downloads"
        downloads.mkdir()
        (downloads / "report.zip").symlink_to(outside)
        result = self.publish()
        self.assertEqual(result["path"], "~/Downloads/report (1).zip")
        self.assertEqual(outside.read_bytes(), b"leave untouched")
        self.assertTrue((downloads / "report.zip").is_symlink())

    def test_parent_symlink_refused(self):
        outside = self.home / "outside"
        outside.mkdir()
        (self.home / "Downloads").symlink_to(outside)
        with self.assertRaises(OSError):
            self.publish()
        self.assertEqual(list(outside.iterdir()), [])

    def test_replaced_download_directory_refused_before_link(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            (self.home / "Downloads").rename(self.home / "old-downloads")
            (self.home / "Downloads").mkdir()
            with self.assertRaisesRegex(p.Refused, "target-changed"):
                owner.commit(fd)
        self.assertNoVisibleFiles()
        self.assertEqual(list((self.home / "old-downloads").iterdir()), [])

    def test_replaced_spool_name_cannot_substitute_pinned_source(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            folder = self.home / ".localdot-downloads" / self.request["transferId"]
            # Replacing the spool path cannot redirect linkat away from the open inode.
            (folder / "payload").rename(folder / "original")
            (folder / "payload").write_bytes(b"not approved")
            result = owner.commit(fd)
        self.assertEqual(self.path(result).read_bytes(), self.bytes)

    def test_payload_mutation_after_ready_refused_before_link(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            os.pwrite(fd, b"X", 0)
            with self.assertRaisesRegex(p.Refused, "digest"):
                owner.commit(fd)
        self.assertNoVisibleFiles()

    def test_initial_digest_mismatch_never_visible(self):
        code, lines = self.command(data=b"X" * len(self.bytes))
        self.assertEqual(code, 1)
        self.assertEqual(lines, [{"error": "digest"}])
        self.assertNoVisibleFiles()
        self.assertFalse((self.home / ".localdot-downloads" / self.request["transferId"] / "payload").exists())

    def test_completed_retry_returns_original_receipt_without_recreating_deleted_file(self):
        result = self.publish()
        self.path(result).unlink()
        with self.owner(reconcile=True) as owner:
            self.assertEqual(owner.reconcile(), result)
        self.assertNoVisibleFiles()

    def test_restart_retires_spool_left_after_durable_receipt(self):
        original = os.unlink
        def interrupted(name, *args, **kwargs):
            if name == "payload":
                raise OSError("crash before spool cleanup")
            return original(name, *args, **kwargs)
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            with patch.object(os, "unlink", side_effect=interrupted):
                with self.assertRaises(OSError):
                    owner.commit(fd)
        folder = self.home / ".localdot-downloads" / self.request["transferId"]
        self.assertTrue((folder / "payload").exists())
        target = self.home / "Downloads" / self.request["name"]
        before = target.stat().st_ino
        with self.owner(reconcile=True) as owner:
            result = owner.reconcile()
        self.assertEqual(self.path(result).stat().st_ino, before)
        self.assertFalse((folder / "payload").exists())
        self.assertEqual(sorted(x.name for x in target.parent.iterdir()), [self.request["name"]])

    def test_lost_reply_returns_original_receipt(self):
        result = self.publish()
        code, lines = self.command(data=b"", commit=b"", reconcile=True)
        self.assertEqual(code, 0)
        self.assertEqual(lines, [{"receipt": result}])
        self.assertEqual(len(list((self.home / "Downloads").iterdir())), 1)

    def test_crash_after_link_before_receipt_reconciles_same_inode(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            with patch.object(owner, "finish", side_effect=RuntimeError("crash after link")):
                with self.assertRaisesRegex(RuntimeError, "crash"):
                    owner.commit(fd)
        target = self.home / "Downloads" / "report.zip"
        inode = target.stat().st_ino
        with self.owner(reconcile=True) as owner:
            result = owner.reconcile()
        self.assertEqual(self.path(result).stat().st_ino, inode)
        self.assertEqual(sorted(x.name for x in target.parent.iterdir()), ["report.zip"])

    def test_uncertain_missing_target_never_creates_another_copy(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            with patch.object(owner, "finish", side_effect=RuntimeError("lost")):
                with self.assertRaises(RuntimeError):
                    owner.commit(fd)
        target = self.home / "Downloads" / "report.zip"
        target.rename(target.parent / "moved-by-user.zip")
        with self.owner(reconcile=True) as owner:
            with self.assertRaisesRegex(p.Refused, "missing-evidence"):
                owner.reconcile()
        self.assertEqual(sorted(x.name for x in target.parent.iterdir()), ["moved-by-user.zip"])

    def test_uncertain_target_replaced_by_same_bytes_refused(self):
        with self.owner() as owner:
            fd = owner.receive(io.BytesIO(self.bytes))
            with patch.object(owner, "finish", side_effect=RuntimeError("lost")):
                with self.assertRaises(RuntimeError):
                    owner.commit(fd)
        target = self.home / "Downloads" / "report.zip"
        target.unlink()
        target.write_bytes(self.bytes)
        with self.owner(reconcile=True) as owner:
            with self.assertRaisesRegex(p.Refused, "target-changed"):
                owner.reconcile()

    def test_receipt_bound_to_every_request_field(self):
        self.publish()
        for key, value in (("parentCellId", ident()), ("name", "other.zip"),
                           ("bytes", 9), ("sha256", "a" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(p.Refused, "stale"):
                with self.owner(dict(self.request, **{key: value}), reconcile=True):
                    pass

    def test_unknown_reconcile_does_not_reserve_a_new_record(self):
        self.publish()
        other = dict(self.request, transferId=ident())
        with self.assertRaisesRegex(p.Refused, "missing-evidence"):
            with self.owner(other, reconcile=True):
                pass
        self.assertFalse((self.home / ".localdot-downloads" / other["transferId"]).exists())

    def test_incomplete_transfer_is_not_restarted_implicitly(self):
        with self.owner() as owner:
            owner.receive(io.BytesIO(self.bytes))
        with self.owner(reconcile=True) as owner:
            result = owner.reconcile()
        self.assertEqual(result, dict(self.request, status="not-placed"))
        with self.owner() as owner:
            self.assertFalse(owner.fresh)
            self.assertEqual(owner.reconcile(), result)
        self.assertNoVisibleFiles()

    def test_receiving_record_is_tombstoned_before_not_placed_acknowledgement(self):
        with self.owner():
            pass
        code, lines = self.command(data=b"", commit=b"", reconcile=True)
        self.assertEqual(code, 0)
        self.assertEqual(lines, [{"notPlaced": dict(self.request, status="not-placed")}])
        record = self.home / ".localdot-downloads" / self.request["transferId"] / "record.json"
        self.assertEqual(json.loads(record.read_text())["state"], "not-placed")
        # A later caller cannot reuse that identity to bypass the permanent cancellation.
        code, repeated = self.command()
        self.assertEqual(code, 0)
        self.assertEqual(repeated, lines)
        self.assertNoVisibleFiles()

    def test_lost_negative_reply_keeps_the_same_permanent_tombstone(self):
        with self.owner() as owner:
            owner.receive(io.BytesIO(self.bytes))
        with self.owner(reconcile=True) as owner:
            result = owner.reconcile()
        with self.owner(reconcile=True) as owner:
            self.assertEqual(owner.reconcile(), result)
        self.assertNoVisibleFiles()

    def test_same_transfer_concurrent_owner_refused(self):
        with self.owner() as owner:
            with self.assertRaisesRegex(p.Refused, "busy"):
                with self.owner(reconcile=True):
                    pass
            owner.receive(io.BytesIO(self.bytes))

    def test_record_capacity_reservation_is_bounded(self):
        self.publish()
        with patch.object(p, "MAX_RECORDS", 1), self.assertRaisesRegex(p.Refused, "capacity"):
            with self.owner(dict(self.request, transferId=ident())):
                pass
        with self.owner(reconcile=True) as owner:
            self.assertEqual(owner.reconcile()["path"], "~/Downloads/report.zip")

    def test_receipt_symlink_refused(self):
        self.publish()
        file = self.home / ".localdot-downloads" / self.request["transferId"] / "record.json"
        outside = self.home / "outside.json"
        file.rename(outside)
        file.symlink_to(outside)
        with self.assertRaises(OSError):
            with self.owner(reconcile=True):
                pass

    def test_malicious_names_and_over_limit_headers_never_create_directories(self):
        for name in ("../outside", "/tmp/bad", "..", "a/b", "a\\b", "a\n", "con.txt", "\x00"):
            with self.subTest(name=name):
                code, _ = self.command(request=dict(self.request, name=name))
                self.assertEqual(code, 1)
        code, _ = self.command(request=dict(self.request, bytes=p.MAX_BYTES + 1))
        self.assertEqual(code, 1)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_unicode_collision_name_stays_bounded(self):
        name = "资料" * 29 + ".txt"
        self.request["name"] = name
        (self.home / "Downloads").mkdir()
        (self.home / "Downloads" / name).write_bytes(b"existing")
        result = self.publish()
        filename = self.path(result).name
        self.assertLessEqual(len(filename.encode("utf-8")), 180)
        self.assertTrue(filename.endswith(" (1).txt"))
        self.assertEqual(self.path(result).read_bytes(), self.bytes)

    def test_commit_requires_explicit_marker_and_exact_eof(self):
        for ending in (b"", b"X", b"Cextra"):
            self.request["transferId"] = ident()
            code, lines = self.command(commit=ending)
            self.assertEqual(code, 1)
            self.assertEqual(lines, [{"ready": True}, {"error": "commit-refused"}])
            self.assertNoVisibleFiles()

    def test_short_source_does_not_reach_ready(self):
        code, lines = self.command(data=b"short", commit=b"")
        self.assertEqual(code, 1)
        self.assertEqual(lines, [{"error": "truncated"}])
        self.assertNoVisibleFiles()

    def test_cli_waits_for_commit_and_sigterm_removes_uncommitted_payload(self):
        child = subprocess.Popen([sys.executable, "-I", "-B", str(HELPER), "--home", str(self.home)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write(json.dumps(dict(version=1, request=self.request, reconcileOnly=False)).encode() + b"\n" + self.bytes)
            child.stdin.flush()
            self.assertEqual(json.loads(child.stdout.readline()), {"ready": True})
            self.assertNoVisibleFiles()
            child.terminate()
            self.assertEqual(child.wait(timeout=3), 1)
            self.assertEqual(json.loads(child.stdout.readline()), {"error": "aborted"})
            self.assertNoVisibleFiles()
            self.assertFalse((self.home / ".localdot-downloads" / self.request["transferId"] / "payload").exists())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()


if __name__ == "__main__":
    unittest.main()
