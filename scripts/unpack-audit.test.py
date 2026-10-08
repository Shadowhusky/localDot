import base64
import gzip
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("archive_audit", Path(__file__).with_name("unpack-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def tar_bytes(entries, *, archive_format=tarfile.PAX_FORMAT):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w", format=archive_format) as archive:
        for entry in entries:
            info = tarfile.TarInfo(entry["name"])
            info.type = entry.get("type", tarfile.REGTYPE)
            info.mode = entry.get("mode", 0o644)
            info.linkname = entry.get("linkname", "")
            info.pax_headers = entry.get("pax", {})
            data = entry.get("data", b"ok")
            info.size = len(data) if info.type == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(data) if info.type == tarfile.REGTYPE else None)
    return result.getvalue()


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="localdot-archive-parser-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_archive(self, raw, *, compressed=False):
        archive = self.root / "package.tgz"
        archive.write_bytes(raw if compressed else gzip.compress(raw, mtime=0))
        stage = self.root / "stage"
        stage.mkdir(mode=0o700)
        return audit.inspect_archive(archive, stage)

    def test_real_file_bytes_and_compressed_integrity(self):
        raw = tar_bytes([{"name": "package/dist/cli.mjs", "data": b"export {};\n", "mode": 0o755}])
        result = self.run_archive(raw)
        self.assertEqual(result["files"], [{"path": "dist/cli.mjs", "size": 11, "mode": 0o755, "sha256": hashlib.sha256(b"export {};\n").hexdigest()}])
        self.assertEqual((self.root / "stage/tree/dist/cli.mjs").read_bytes(), b"export {};\n")
        self.assertEqual(result["integrity"], "sha512-" + base64.b64encode(hashlib.sha512((self.root / "package.tgz").read_bytes()).digest()).decode())

    def test_valid_pax_long_name(self):
        name = "package/web/dist/assets/" + "a" * 120 + ".js"
        result = self.run_archive(tar_bytes([{"name": name}]))
        self.assertEqual(result["files"][0]["path"], name[len("package/"):])

    def test_valid_gnu_long_name(self):
        name = "package/web/dist/assets/" + "a" * 120 + ".js"
        result = self.run_archive(tar_bytes([{"name": name}], archive_format=tarfile.GNU_FORMAT))
        self.assertEqual(len(result["files"]), 1)

    def test_paths_cannot_escape_or_use_other_roots(self):
        for name in ["package/../escape", "/absolute", "other/a", "package//a", "package/./a", "package/a\\b", "package/.env"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as root:
                archive = Path(root) / "a.tgz"; archive.write_bytes(gzip.compress(tar_bytes([{"name": name}]), mtime=0))
                stage = Path(root) / "stage"; stage.mkdir(mode=0o700)
                with self.assertRaises(audit.ArchiveError): audit.inspect_archive(archive, stage)
                self.assertFalse((Path(root) / "escape").exists())

    def test_duplicate_and_case_collision(self):
        for second in ["package/a.js", "package/A.JS"]:
            with self.subTest(second=second), tempfile.TemporaryDirectory(dir=self.root) as root:
                archive = Path(root) / "a.tgz"; archive.write_bytes(gzip.compress(tar_bytes([{"name": "package/a.js"}, {"name": second}]), mtime=0))
                stage = Path(root) / "stage"; stage.mkdir(mode=0o700)
                with self.assertRaises(audit.ArchiveError): audit.inspect_archive(archive, stage)

    def test_links_devices_and_fifo_are_refused(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as root:
                archive = Path(root) / "a.tgz"; archive.write_bytes(gzip.compress(tar_bytes([{"name": "package/a", "type": kind, "linkname": "../../outside"}]), mtime=0))
                stage = Path(root) / "stage"; stage.mkdir(mode=0o700)
                with self.assertRaises(audit.ArchiveError): audit.inspect_archive(archive, stage)

    def test_special_permissions_are_refused(self):
        with self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a", "mode": 0o4755}]))

    def test_unused_directory_is_refused(self):
        with self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/hidden", "type": tarfile.DIRTYPE}, {"name": "package/a"}]))

    def test_pax_size_override_is_refused(self):
        with self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a", "pax": {"size": "2"}}]))

    def test_sparse_pax_is_refused(self):
        with self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a", "pax": {"GNU.sparse.map": "0,2"}}]))

    def test_member_byte_limit(self):
        with patch.object(audit, "MAX_FILE", 1), self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a", "data": b"too big"}]))

    def test_aggregate_byte_limit(self):
        with patch.object(audit, "MAX_TOTAL", 3), self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a"}, {"name": "package/b"}]))

    def test_inflated_byte_limit(self):
        with patch.object(audit, "MAX_EXPANDED", 512), self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a"}]))

    def test_file_count_limit(self):
        with patch.object(audit, "MAX_FILES", 1), self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a"}, {"name": "package/b"}]))

    def test_gzip_filename_metadata_is_refused(self):
        out = io.BytesIO()
        with gzip.GzipFile(filename="private-name", fileobj=out, mode="wb", mtime=0) as compressed:
            compressed.write(tar_bytes([{"name": "package/a"}]))
        with self.assertRaises(audit.ArchiveError): self.run_archive(out.getvalue(), compressed=True)

    def test_concatenated_gzip_is_refused(self):
        first = gzip.compress(tar_bytes([{"name": "package/a"}]), mtime=0)
        with self.assertRaises(audit.ArchiveError): self.run_archive(first + gzip.compress(b"hidden", mtime=0), compressed=True)

    def test_concatenated_tar_is_refused(self):
        with self.assertRaises(audit.ArchiveError):
            self.run_archive(tar_bytes([{"name": "package/a"}]) + tar_bytes([{"name": "package/hidden"}]))

    def test_nonzero_padding_is_refused(self):
        raw = bytearray(tar_bytes([{"name": "package/a"}]))
        raw[514] = 65
        with self.assertRaises(audit.ArchiveError): self.run_archive(bytes(raw))

    def test_bad_checksum_is_refused(self):
        raw = bytearray(tar_bytes([{"name": "package/a"}]))
        raw[0] = 65
        with self.assertRaises(tarfile.TarError): self.run_archive(bytes(raw))

    def test_truncated_gzip_is_refused(self):
        raw = gzip.compress(tar_bytes([{"name": "package/a"}]), mtime=0)
        with self.assertRaises(audit.ArchiveError): self.run_archive(raw[:-4], compressed=True)

    def test_missing_tar_end_is_refused(self):
        with self.assertRaises(audit.ArchiveError): self.run_archive(tar_bytes([{"name": "package/a"}])[:1024])

    def test_metadata_bytes_are_preserved_for_hygiene(self):
        self.run_archive(tar_bytes([{"name": "package/a", "pax": {"comment": "audit-marker"}}]))
        self.assertIn(b"audit-marker", (self.root / "stage/metadata.bin").read_bytes())

    def test_existing_stage_is_preserved(self):
        stage = self.root / "stage"; stage.mkdir(mode=0o700)
        marker = stage / "keep"; marker.write_text("preserve")
        with self.assertRaises(audit.ArchiveError): audit.inspect_archive(self.root / "missing", stage)
        self.assertEqual(marker.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
