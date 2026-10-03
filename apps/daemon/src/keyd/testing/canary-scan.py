"""Scan process data and regular files for raw and encoded canary bytes.

Run inside the owned test cell as root with docker exec --privileged. The scanner's
own process contains its needles, so it is excluded. Counts reflect actual reads,
not mapped bytes or repeated paths. Memory hits and byte counts identify their PID
and process name; read diagnostics distinguish vanished processes from inspection
gaps. --no-processes permits scanning host artifacts.
"""

import argparse
import base64
import errno
import json
import os
import stat

CHUNK = 4 << 20


def forms(needle):
    yield "raw", needle
    # Exclude partial base64 groups whose bits depend on adjacent bytes. Searching
    # these internal runs covers both standalone and embedded secrets at all offsets.
    for label, encode in (("base64", base64.b64encode), ("base64url", base64.urlsafe_b64encode)):
        for shift in range(3):
            encoded = encode(b"\0" * shift + needle)
            start = 4 if shift else 0
            end = (shift + len(needle)) // 3 * 4
            run = encoded[start:end]
            if run:
                yield label + (f"+{shift}" if shift else ""), run
    yield "hex", needle.hex().encode()
    yield "HEX", needle.hex().upper().encode()
    yield "utf16le", needle.decode("utf-8").encode("utf-16-le")


def scan_stream(read, patterns, found, where):
    overlap = max(len(pattern) for _, _, pattern in patterns) - 1
    tail = b""
    total = 0
    while True:
        data = read()
        if not data:
            return total
        total += len(data)
        window = tail + data
        for needle, label, pattern in patterns:
            if pattern in window:
                found.add((needle, label, where))
        tail = window[-overlap:] if overlap else b""


def scan_processes(patterns, found, proc_root="/proc"):
    scanned = total = unreadable = 0
    memory_hits, memory_reads, process_errors = [], [], []
    me = str(os.getpid())
    for pid in sorted(os.listdir(proc_root)):
        if not pid.isdigit() or pid == me:
            continue
        directory = os.path.join(proc_root, pid)
        comm = ""

        def report(surface, error, mapping=None):
            nonlocal unreadable
            try:
                os.stat(directory)
                vanished = False
            except OSError as status_error:
                vanished = status_error.errno in (errno.ENOENT, errno.ESRCH)
            item = {"pid": int(pid), "comm": comm, "surface": surface,
                    "errno": error.errno or errno.EIO, "vanished": vanished}
            if mapping is not None:
                item["mapping"] = mapping
            process_errors.append(item)
            if surface in ("maps", "memory"):
                unreadable += 1

        try:
            with open(os.path.join(directory, "comm"), encoding="utf-8", errors="replace") as source:
                comm = source.read(256).rstrip("\n")
        except OSError as error:
            report("comm", error)
        actual = {"pid": int(pid), "comm": comm, "bytes": 0}
        memory_reads.append(actual)
        for kind in ("environ", "cmdline"):
            try:
                with open(os.path.join(directory, kind), "rb") as source:
                    scan_stream(lambda: source.read(CHUNK), patterns, found, kind)
            except OSError as error:
                report(kind, error)
        try:
            with open(os.path.join(directory, "maps"), encoding="utf-8") as source:
                maps = source.read().splitlines()
        except OSError as error:
            report("maps", error)
            continue
        try:
            memory = open(os.path.join(directory, "mem"), "rb", 0)
        except OSError as error:
            report("memory", error)
            continue
        process_found = set()
        with memory:
            for line in maps:
                fields = line.split()
                if len(fields) < 2:
                    report("maps", OSError(errno.EINVAL, "invalid memory map"))
                    continue
                if "r" not in fields[1]:
                    continue
                # Linux advertises these kernel pseudo-mappings as readable but
                # refuses /proc/pid/mem access to them. Other failures are reported.
                if len(fields) > 5 and fields[5] in ("[vvar]", "[vvar_vclock]", "[vsyscall]"):
                    continue
                try:
                    start, end = (int(value, 16) for value in fields[0].split("-"))
                    if end <= start:
                        raise ValueError("empty memory map")
                except ValueError:
                    report("maps", OSError(errno.EINVAL, "invalid memory map"), fields[0])
                    continue
                position = start

                def read():
                    nonlocal position, total
                    if position >= end:
                        return b""
                    memory.seek(position)
                    data = memory.read(min(CHUNK, end - position))
                    if not data:
                        raise OSError(errno.EIO, "memory mapping ended before its reported size")
                    position += len(data)
                    total += len(data)
                    actual["bytes"] += len(data)
                    return data

                try:
                    scan_stream(read, patterns, process_found, "memory")
                except OSError as error:
                    # Keep the readable prefix and continue with other mappings.
                    # A vanished process is distinguishable from a persistent
                    # permissions or I/O gap in this non-atomic snapshot.
                    report("memory", error, fields[0])
        if actual["bytes"]:
            scanned += 1
        found.update(process_found)
        memory_hits.extend(
            {"pid": int(pid), "comm": comm, "needle": needle, "form": label}
            for needle, label, _ in sorted(process_found)
        )
    return scanned, total, unreadable, memory_hits, memory_reads, process_errors


def scan_files(roots, patterns, found):
    count = total = 0
    seen = set()
    errors = []

    def paths(root):
        if os.path.islink(root):
            return
        if not os.path.isdir(root):
            yield root
            return
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=lambda e: errors.append(str(e))):
            dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(directory, name))]
            for name in names:
                yield os.path.join(directory, name)

    for root in roots:
        for path in paths(root):
            try:
                metadata = os.lstat(path)
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                identity = (metadata.st_dev, metadata.st_ino)
                if identity in seen:
                    continue
                # Refuse symlink substitution between traversal and opening.
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, "rb") as source:
                    actual = os.fstat(source.fileno())
                    if not stat.S_ISREG(actual.st_mode):
                        continue
                    identity = (actual.st_dev, actual.st_ino)
                    if identity in seen:
                        continue
                    size = scan_stream(lambda: source.read(CHUNK), patterns, found, "file " + path)
                seen.add(identity)
                count += 1
                total += size
            except FileNotFoundError:
                pass  # Ephemeral files may disappear during the snapshot.
            except OSError as error:
                errors.append(f"{path}: {error.strerror}")
    return count, total, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("needles", nargs="+")
    parser.add_argument("--files", nargs="*", default=[])
    parser.add_argument("--no-processes", action="store_true")
    args = parser.parse_args()
    if any(len(needle.encode()) < 12 for needle in args.needles):
        parser.error("use needles of at least 12 UTF-8 bytes")
    patterns = [(needle, label, pattern) for needle in args.needles for label, pattern in forms(needle.encode())]
    found = set()
    process_scan = (0, 0, 0, [], [], []) if args.no_processes else scan_processes(patterns, found)
    processes, size, unreadable, memory_hits, memory_reads, process_errors = process_scan
    files, file_bytes, file_errors = scan_files(args.files, patterns, found)
    print(json.dumps({
        "processes": processes, "bytes": size, "files": files,
        "fileBytes": file_bytes, "unreadableMemory": unreadable, "fileErrors": file_errors,
        "memoryHits": memory_hits, "memoryReads": memory_reads, "processErrors": process_errors,
        "hits": sorted(f"{needle}|{label}|{where}" for needle, label, where in found),
    }))


if __name__ == "__main__":
    main()
