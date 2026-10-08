"""Build-time archive inspection. Never execute members or preserve archive links/attributes."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import zlib

MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILES = 4096
MAX_HEADERS = MAX_FILES * 3
MAX_METADATA = 8 * 1024 * 1024
MAX_EXPANDED = MAX_TOTAL + MAX_HEADERS * 512 + MAX_METADATA + 65536
PATH_PATTERN = re.compile(r"[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*\Z")
PAX_KEYS = {"path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset", "comment"}


class ArchiveError(Exception):
    pass


def require(value, code):
    if not value:
        raise ArchiveError(code)


def signature(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def inflate(source, destination):
    before = os.fstat(source.fileno())
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "invalid-source")
    require(before.st_size <= MAX_EXPANDED, "archive-limit")
    header = source.read(10)
    # npm emits a single gzip stream without filename/comment/extra headers.
    require(len(header) == 10 and header[:4] == b"\x1f\x8b\x08\x00", "invalid-gzip")
    source.seek(0)
    digest = hashlib.sha512()
    decoder = zlib.decompressobj(31)
    size = 0
    with destination.open("xb") as output:
        os.chmod(destination, 0o600)
        while chunk := source.read(65536):
            require(not decoder.eof, "trailing-gzip")
            digest.update(chunk)
            while chunk:
                data = decoder.decompress(chunk, min(65536, MAX_EXPANDED - size + 1))
                size += len(data)
                require(size <= MAX_EXPANDED, "archive-limit")
                output.write(data)
                require(not decoder.unused_data, "trailing-gzip")
                chunk = decoder.unconsumed_tail
    require(decoder.eof, "truncated-gzip")
    require(signature(os.fstat(source.fileno())) == signature(before), "source-changed")
    return "sha512-" + base64.b64encode(digest.digest()).decode("ascii"), size


def check_pax(payload):
    cursor, seen = 0, set()
    while cursor < len(payload):
        space = payload.find(b" ", cursor, cursor + 12)
        require(space > cursor, "invalid-pax")
        digits = payload[cursor:space]
        require(digits.isdigit() and not digits.startswith(b"0"), "invalid-pax")
        length = int(digits)
        end = cursor + length
        require(end <= len(payload) and end > space + 3 and payload[end - 1:end] == b"\n", "invalid-pax")
        record = payload[space + 1:end - 1]
        require(b"=" in record, "invalid-pax")
        key, value = record.split(b"=", 1)
        key = key.decode("ascii")
        require(key in PAX_KEYS and key not in seen, "unsupported-pax")
        value.decode("utf8", errors="strict")
        seen.add(key)
        cursor = end


def preflight(raw, size, metadata):
    require(size % 512 == 0, "invalid-tar")
    offset, count, metadata_size = 0, 0, 0
    with raw.open("rb") as stream, metadata.open("xb") as meta:
        os.chmod(metadata, 0o600)
        while offset < size:
            stream.seek(offset)
            header = stream.read(512)
            if header == bytes(512):
                tail_size = size - offset
                require(1024 <= tail_size <= 65536, "missing-end")
                require(not any(stream.read()), "trailing-tar")
                return
            count += 1
            require(count <= MAX_HEADERS, "archive-limit")
            info = tarfile.TarInfo.frombuf(header, "utf8", "strict")
            require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME), "unsupported-type")
            require(0 <= info.size <= MAX_FILE, "member-limit")
            require(info.type != tarfile.DIRTYPE or info.size == 0, "invalid-directory")
            metadata_size += 512
            meta.write(header)
            is_metadata = info.type in (tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME)
            if is_metadata:
                require(info.size <= 32768, "metadata-limit")
                payload = stream.read(info.size)
                require(len(payload) == info.size, "truncated-tar")
                metadata_size += len(payload)
                meta.write(payload)
                if info.type == tarfile.XHDTYPE:
                    check_pax(payload)
            require(metadata_size <= MAX_METADATA, "metadata-limit")
            end = offset + 512 + info.size
            padded = (end + 511) // 512 * 512
            require(padded <= size, "truncated-tar")
            stream.seek(end)
            require(not any(stream.read(padded - end)), "bad-padding")
            offset = padded
    raise ArchiveError("missing-end")


def copy_members(raw, tree):
    files, directories, seen, total, members = [], [], set(), 0, 0
    tree.mkdir(mode=0o700)
    with tarfile.open(raw, mode="r:", encoding="utf8", errors="strict") as archive:
        for member in archive:
            members += 1
            require(members <= MAX_FILES * 2, "archive-limit")
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and member.sparse is None, "unsupported-type")
            name = member.name.rstrip("/") if member.isdir() else member.name
            require(name == "package" or name.startswith("package/"), "unsafe-member")
            relative = name.removeprefix("package/") if name != "package" else ""
            require((relative or member.isdir()) and len(relative) <= 512 and len(relative.split("/")) <= 16, "unsafe-member")
            require(not relative or PATH_PATTERN.fullmatch(relative), "unsafe-member")
            key = name.lower()
            require(key not in seen, "duplicate-member")
            seen.add(key)
            require((member.mode & 0o7000) == 0, "unsafe-mode")
            target = tree.joinpath(*relative.split("/")) if relative else tree
            if member.isdir():
                require(member.size == 0, "invalid-directory")
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                if relative:
                    directories.append(relative)
                continue
            require(0 <= member.size <= MAX_FILE and len(files) < MAX_FILES, "member-limit")
            total += member.size
            require(total <= MAX_TOTAL, "archive-limit")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            digest, written = hashlib.sha256(), 0
            reader = archive.extractfile(member)
            require(reader is not None, "invalid-member")
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with reader, os.fdopen(fd, "wb") as output:
                while chunk := reader.read(65536):
                    written += len(chunk)
                    require(written <= member.size, "member-limit")
                    digest.update(chunk)
                    output.write(chunk)
            require(written == member.size, "truncated-member")
            files.append({"path": relative, "size": written, "mode": member.mode & 0o777, "sha256": digest.hexdigest()})
    require(all(any(file["path"].startswith(directory + "/") for file in files) for directory in directories), "unused-directory")
    return files


def inspect_archive(archive, root):
    st = root.lstat()
    require(stat.S_ISDIR(st.st_mode) and not root.is_symlink() and st.st_uid == os.getuid() and (st.st_mode & 0o077) == 0 and not list(root.iterdir()), "invalid-staging")
    require(stat.S_ISREG(archive.lstat().st_mode), "invalid-source")
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        integrity, size = inflate(source, root / "archive.tar")
    preflight(root / "archive.tar", size, root / "metadata.bin")
    return {"integrity": integrity, "files": copy_members(root / "archive.tar", root / "tree")}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 3, "invalid-arguments")
        result = inspect_archive(Path(sys.argv[1]), Path(sys.argv[2]))
        print(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"error": str(error) if isinstance(error, ArchiveError) else "invalid-archive"}))
        sys.exit(1)
