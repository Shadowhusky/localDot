#!/usr/bin/python3
"""Bounded desktop delivery. All source bytes must already have host approval.

stdin: one bounded JSON header line, exactly request.bytes bytes, then (only after
the ready response) C and EOF. stdout: ready followed by one receipt/error line.
The desktop is a recipient, not a host-secret boundary; it permits user sudo.
This helper never runs/open/extracts a payload, and never reads a browser profile.
"""

import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import sys
import unicodedata
import uuid


MAX_BYTES = 1024 * 1024 * 1024
MAX_RECORDS = 4096
BLOCK = 64 * 1024
META_BYTES = 16 * 1024
ID = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
NOFOLLOW = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW


class Refused(Exception):
    pass


def require(condition, reason="corrupt"):
    if not condition:
        raise Refused(reason)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys), "request")


def canonical_name(value):
    value = unicodedata.normalize("NFC", value)
    value = "".join(
        "_" if unicodedata.category(c) in ("Cc", "Cf") or c in '<>:"/\\|?*' else c
        for c in value
    )
    value = value.strip(". \t\n\r\v\f")
    if re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", value, re.I):
        value = "_" + value
    value = value.encode("utf-8")[:180].decode("utf-8", errors="ignore").rstrip(". ")
    return value or "download"


def request_value(value):
    exact(value, ("transferId", "parentCellId", "name", "bytes", "sha256"))
    require(all(isinstance(value[k], str) for k in ("transferId", "parentCellId", "name", "sha256")), "request")
    require(ID.fullmatch(value["transferId"]) and ID.fullmatch(value["parentCellId"]), "request")
    require(type(value["bytes"]) is int and 0 <= value["bytes"] <= MAX_BYTES, "request")
    require(re.fullmatch(r"[0-9a-f]{64}", value["sha256"]), "request")
    require(0 < len(value["name"].encode("utf-8")) <= 180 and canonical_name(value["name"]) == value["name"], "request")
    return value


def identity(value):
    return (value.st_dev, value.st_ino)


def file_stat(fd, mode, links=(1,)):
    value = os.fstat(fd)
    require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid())
    require(stat.S_IMODE(value.st_mode) == mode and value.st_nlink in links)
    return value


def directory(fd, private=False):
    value = os.fstat(fd)
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid())
    require(stat.S_IMODE(value.st_mode) == 0o700 if private else not value.st_mode & 0o022)
    return value


def open_dir(parent, name, create=False, private=False):
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        directory(fd, private)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_record(folder):
    fd = os.open("record.json", os.O_RDONLY | NOFOLLOW, dir_fd=folder)
    try:
        before = file_stat(fd, 0o600)
        require(before.st_size <= META_BYTES)
        data = os.read(fd, META_BYTES + 1)
        after = file_stat(fd, 0o600)
        require(len(data) == before.st_size and identity(before) == identity(after))
        require(before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns)
        record = json.loads(data)
    finally:
        os.close(fd)
    exact(record, ("version", "request", "state", "target", "inode"))
    require(type(record["version"]) is int and record["version"] == 1)
    request_value(record["request"])
    require(record["state"] in ("receiving", "verified", "linking", "complete", "not-placed"))
    if record["state"] in ("receiving", "not-placed"):
        require(record["target"] is None and record["inode"] is None)
    else:
        require(isinstance(record["inode"], list) and len(record["inode"]) == 2)
        require(all(type(n) is int and n >= 0 for n in record["inode"]))
        if record["state"] == "verified":
            require(record["target"] is None)
        else:
            require(isinstance(record["target"], str) and canonical_name(record["target"]) == record["target"])
            require(record["target"] in [candidate(record["request"]["name"], n) for n in range(100)])
    return record


def write_record(folder, record):
    name = "record-" + uuid.uuid4().hex + ".part"
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=folder)
    try:
        write_all(fd, json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
        os.fsync(fd)
        file_stat(fd, 0o600)
        os.replace(name, "record.json", src_dir_fd=folder, dst_dir_fd=folder)
        os.fsync(folder)
    finally:
        os.close(fd)
        try:
            os.unlink(name, dir_fd=folder)
        except FileNotFoundError:
            pass


def write_all(fd, value):
    view = memoryview(value)
    while view:
        count = os.write(fd, view)
        require(count > 0, "unavailable")
        view = view[count:]


def candidate(name, index):
    if index == 0:
        return name
    stem, extension = os.path.splitext(name)
    if len(extension.encode("utf-8")) > 40:
        stem, extension = name, ""
    suffix = " (" + str(index) + ")" + extension
    stem = stem.encode("utf-8")[:180 - len(suffix.encode("utf-8"))].decode("utf-8", errors="ignore").rstrip(". ")
    return canonical_name((stem or "download") + suffix)


def hash_payload(fd, request, links=(1,)):
    before = file_stat(fd, 0o644, links)
    require(before.st_size == request["bytes"])
    digest = hashlib.sha256()
    offset = 0
    while offset < before.st_size:
        block = os.pread(fd, min(BLOCK, before.st_size - offset), offset)
        require(block)
        digest.update(block)
        offset += len(block)
    after = file_stat(fd, 0o644, links)
    require(identity(before) == identity(after) and before.st_size == after.st_size)
    require(before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns)
    require(digest.hexdigest() == request["sha256"], "digest")
    return before


class Delivery:
    def __init__(self, home, request, reconcile_only):
        require(sys.platform == "linux", "unavailable")
        self.home_path = os.path.realpath(home)
        self.request = request_value(request)
        self.fds = []
        self.home = self.keep(os.open(self.home_path, DIRECTORY))
        directory(self.home)
        self.ledger = self.keep(open_dir(self.home, ".localdot-downloads", create=not reconcile_only, private=True))
        self.downloads = self.keep(open_dir(self.home, "Downloads", create=not reconcile_only))
        if reconcile_only:
            self.fresh = False
        else:
            try:
                fcntl.flock(self.ledger, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused("busy") from None
            try:
                try:
                    os.stat(request["transferId"], dir_fd=self.ledger, follow_symlinks=False)
                    self.fresh = False
                except FileNotFoundError:
                    # Bound permanent receipts; never expire one and accidentally admit
                    # its transfer identity a second time. Serialize capacity reservation.
                    count = 0
                    with os.scandir(self.ledger) as entries:
                        for _ in entries:
                            count += 1
                            require(count < MAX_RECORDS, "capacity")
                    os.mkdir(request["transferId"], mode=0o700, dir_fd=self.ledger)
                    self.fresh = True
                    os.fsync(self.ledger)
            finally:
                fcntl.flock(self.ledger, fcntl.LOCK_UN)
        try:
            self.folder = self.keep(open_dir(self.ledger, request["transferId"], private=True))
        except FileNotFoundError:
            raise Refused("missing-evidence") from None
        try:
            fcntl.flock(self.folder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("busy") from None
        if self.fresh:
            self.record = {"version": 1, "request": request, "state": "receiving", "target": None, "inode": None}
            write_record(self.folder, self.record)
        else:
            self.record = read_record(self.folder)
            require(self.record["request"] == request, "stale")
        self.check_dirs()

    def keep(self, fd):
        self.fds.append(fd)
        return fd

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []

    def cleanup_incomplete(self):
        if hasattr(self, "record") and self.record["state"] in ("receiving", "verified"):
            self.check_dirs()
            try:
                os.unlink("payload", dir_fd=self.folder)
                os.fsync(self.folder)
            except FileNotFoundError:
                pass

    def check_dirs(self):
        require(identity(os.stat(self.home_path, follow_symlinks=False)) == identity(directory(self.home)), "target-changed")
        for parent, name, fd, private in (
            (self.home, ".localdot-downloads", self.ledger, True),
            (self.home, "Downloads", self.downloads, False),
            (self.ledger, self.request["transferId"], self.folder, True),
        ):
            value = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(identity(value) == identity(directory(fd, private)), "target-changed")

    def receipt(self):
        return dict(self.request, path="~/Downloads/" + self.record["target"])

    def finish(self):
        self.check_dirs()
        os.fsync(self.downloads)
        self.record["state"] = "complete"
        write_record(self.folder, self.record)
        try:
            os.unlink("payload", dir_fd=self.folder)
            os.fsync(self.folder)
        except FileNotFoundError:
            pass
        self.check_dirs()
        return self.receipt()

    def reconcile(self):
        self.check_dirs()
        if self.record["state"] in ("receiving", "verified", "not-placed"):
            # Holding the directory lock proves the old writer has physically retired.
            # Persist the terminal tombstone before acknowledging that no link was made.
            # Every future request with this identity returns the same result; it can
            # never become a new placement, even with reconcileOnly=false.
            self.record.update(state="not-placed", target=None, inode=None)
            write_record(self.folder, self.record)
            try:
                os.unlink("payload", dir_fd=self.folder)
                os.fsync(self.folder)
            except FileNotFoundError:
                pass
            self.check_dirs()
            return dict(self.request, status="not-placed")
        if self.record["state"] == "complete":
            # Receipt describes completed delivery; editing/deleting that file later never
            # makes a repeated transfer a fresh write. Finish also retires a private spool
            # link left by a crash between the durable receipt and unlink.
            return self.finish()
        require(self.record["state"] == "linking", "incomplete")
        try:
            fd = self.keep(os.open(self.record["target"], os.O_RDONLY | NOFOLLOW, dir_fd=self.downloads))
        except FileNotFoundError:
            raise Refused("missing-evidence") from None
        value = hash_payload(fd, self.request, (1, 2))
        require(list(identity(value)) == self.record["inode"], "target-changed")
        return self.finish()

    def receive(self, source):
        require(self.fresh)
        fd = self.keep(os.open("payload", os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=self.folder))
        remaining = self.request["bytes"]
        digest = hashlib.sha256()
        while remaining:
            block = source.read(min(remaining, BLOCK))
            require(block, "truncated")
            require(len(block) <= remaining, "request")
            write_all(fd, block)
            digest.update(block)
            remaining -= len(block)
        require(digest.hexdigest() == self.request["sha256"], "digest")
        value = file_stat(fd, 0o600)
        require(value.st_size == self.request["bytes"])
        os.fchmod(fd, 0o644)
        os.fsync(fd)
        self.check_dirs()
        self.record.update(state="verified", inode=list(identity(value)))
        write_record(self.folder, self.record)
        return fd

    def commit(self, fd):
        require(self.record["state"] == "verified")
        value = hash_payload(fd, self.request)
        require(list(identity(value)) == self.record["inode"])
        for index in range(100):
            self.check_dirs()
            target = candidate(self.request["name"], index)
            self.record.update(state="linking", target=target)
            write_record(self.folder, self.record)
            self.check_dirs()
            try:
                # A pinned source descriptor, not the mutable spool filename. Supplying
                # dst_dir_fd selects Linux linkat + AT_SYMLINK_FOLLOW for /proc/self/fd.
                # linkat never replaces an existing destination (including a symlink).
                os.link("/proc/self/fd/" + str(fd), target, dst_dir_fd=self.downloads, follow_symlinks=True)
            except FileExistsError:
                continue
            linked = os.stat(target, dir_fd=self.downloads, follow_symlinks=False)
            require(stat.S_ISREG(linked.st_mode) and identity(linked) == identity(value), "target-changed")
            return self.finish()
        raise Refused("collision")


def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def main():
    owner = None
    def cancelled(_signal, _frame):
        # A second transport cancellation must not interrupt fsync/unlink in finally.
        # The parent retains a bounded SIGKILL fallback if retirement itself stalls.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise Refused("aborted")
    signal.signal(signal.SIGTERM, cancelled)
    try:
        require(len(sys.argv) == 3 and sys.argv[1] == "--home", "request")
        source = sys.stdin.buffer
        line = source.readline(META_BYTES + 1)
        require(len(line) <= META_BYTES and line.endswith(b"\n"), "request")
        header = json.loads(line)
        exact(header, ("version", "request", "reconcileOnly"))
        require(type(header["version"]) is int and header["version"] == 1 and type(header["reconcileOnly"]) is bool, "request")
        owner = Delivery.__new__(Delivery)
        owner.fds = []
        owner.__init__(sys.argv[2], header["request"], header["reconcileOnly"])
        if not owner.fresh:
            receipt = owner.reconcile()
        else:
            fd = owner.receive(source)
            emit({"ready": True})
            # Host transport sends this only after exact source EOF and a final live-authority
            # check. A truncated, overlong or cancelled transport cannot implicitly commit.
            require(source.read(1) == b"C" and source.read(1) == b"", "commit-refused")
            receipt = owner.commit(fd)
        emit({"notPlaced" if receipt.get("status") == "not-placed" else "receipt": receipt})
        return 0
    except Refused as error:
        emit({"error": str(error)})
        return 1
    except (OSError, ValueError, TypeError, KeyError, UnicodeError):
        emit({"error": "unavailable"})
        return 1
    finally:
        if owner is not None:
            try:
                owner.cleanup_incomplete()
            except (OSError, Refused):
                pass
            finally:
                owner.close()


if __name__ == "__main__":
    sys.exit(main())
