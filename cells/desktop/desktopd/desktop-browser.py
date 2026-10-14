#!/usr/bin/python3
"""Own the desktop's temporary Chromium profiles and their process sessions.

The fixed root is a private Docker tmpfs, never the signed-in browser's volume.
An exclusive descriptor lock serializes launches, retirement and crash recovery.
The desktop user can run sudo/arbitrary programs; this is lifecycle isolation,
not a sandbox against that user deliberately launching an unmanaged browser.
"""

import contextlib
import fcntl
import json
import os
import re
import select
import signal
import stat
import sys
import time
import uuid

ROOT = "/run/localdot-desktop-browser"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
TASK = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
GENERATION = re.compile(r"^[0-9a-f]{32}$")
# A new profile draws Chromium's frame from the GTK theme, so its window buttons are the desktop's.
PREFERENCES = b'{"browser":{"custom_chrome_frame":true},"extensions":{"theme":{"system_theme":1}}}'
# A window opened without a page says that sign-ins here aren't kept (packages/protocol accounts.ts).
NOTICE = "file:///opt/localdot/desktop-browser.html"


class Refused(Exception):
    pass


def with_start_page(arguments):
    if any(not arg.startswith("--") for arg in arguments):
        return list(arguments)
    return [*arguments, NOTICE]


def require(value):
    if not value:
        raise Refused("desktop browser retirement could not be confirmed")


def inode(value):
    return [value.st_dev, value.st_ino]


def proc(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            text = f.read(4096)
        fields = text[text.rindex(b")") + 2:].split()
        return {"pid": pid, "state": fields[0].decode("ascii"), "group": int(fields[2]),
                "session": int(fields[3]), "start": int(fields[19]),
                "uid": os.stat(f"/proc/{pid}").st_uid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def members(owner):
    leader = proc(owner["pid"])
    require(leader is None or leader["start"] == owner["start"])
    result = []
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        value = proc(int(name))
        if value is None or (value["session"] != owner["pid"] and value["group"] != owner["pid"]):
            continue
        require(value["uid"] == os.getuid() and value["start"] >= owner["start"])
        # Zombies have closed their file descriptors and cannot write a profile.
        if value["state"] not in ("Z", "X"):
            result.append(value)
    return result


def retire(owner):
    deadline = time.monotonic() + 5
    while True:
        live = members(owner)
        if not live:
            return
        require(time.monotonic() < deadline)
        for value in live:
            try:
                fd = os.pidfd_open(value["pid"])
            except ProcessLookupError:
                continue
            try:
                current = proc(value["pid"])
                if current is not None:
                    require(current["start"] == value["start"])
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        time.sleep(0.01)


class Profiles:
    def __init__(self, root=ROOT):
        self.root = root

    @contextlib.contextmanager
    def locked(self):
        root = os.open(self.root, DIRECTORY)
        lock = None
        try:
            initial = os.fstat(root)
            require(initial.st_uid == os.getuid() and stat.S_IMODE(initial.st_mode) == 0o700)
            lock = os.open("lock", os.O_RDWR | os.O_CREAT | FILE, 0o600, dir_fd=root)
            info = os.fstat(lock)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid())
            require(stat.S_IMODE(info.st_mode) == 0o600)
            deadline = time.monotonic() + 8
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < deadline)
                    time.sleep(0.01)
            require(inode(os.stat(self.root, follow_symlinks=False)) == inode(initial))
            require(inode(os.stat("lock", dir_fd=root, follow_symlinks=False)) == inode(info))
            yield root
        finally:
            if lock is not None:
                os.close(lock)
            os.close(root)

    def read(self, root):
        try:
            fd = os.open("state.json", os.O_RDONLY | FILE, dir_fd=root)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1)
            require(stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 16384)
            value = json.loads(os.read(fd, 16385))
        finally:
            os.close(fd)
        require(isinstance(value, dict) and set(value) == {"version", "taskId", "generation", "inode", "phase", "groups"})
        require(type(value["version"]) is int and value["version"] == 1)
        require(value["taskId"] is None or (isinstance(value["taskId"], str) and TASK.fullmatch(value["taskId"])))
        require(isinstance(value["generation"], str) and GENERATION.fullmatch(value["generation"]))
        require(isinstance(value["inode"], list) and len(value["inode"]) == 2 and all(type(n) is int and n >= 0 for n in value["inode"]))
        require(value["phase"] in ("ready", "retiring"))
        require(isinstance(value["groups"], list) and len(value["groups"]) <= 32)
        for group in value["groups"]:
            require(isinstance(group, dict) and set(group) == {"pid", "start"})
            require(type(group["pid"]) is int and group["pid"] > 1 and type(group["start"]) is int and group["start"] > 0)
        require(len({g["pid"] for g in value["groups"]}) == len(value["groups"]))
        return value

    def write(self, root, value):
        name = "state-" + uuid.uuid4().hex
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o600, dir_fd=root)
        try:
            data = json.dumps(value, separators=(",", ":")).encode("ascii")
            while data:
                data = data[os.write(fd, data):]
            os.fsync(fd)
            os.replace(name, "state.json", src_dir_fd=root, dst_dir_fd=root)
            os.fsync(root)
        finally:
            os.close(fd)
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name, dir_fd=root)

    def profile(self, root, value):
        name = "profile-" + value["generation"]
        fd = os.open(name, DIRECTORY, dir_fd=root)
        try:
            info = os.fstat(fd)
            require(inode(info) == value["inode"] and info.st_uid == os.getuid())
            require(stat.S_IMODE(info.st_mode) == 0o700)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def seed(self, root, value):
        folder = self.profile(root, value)
        try:
            os.mkdir("Default", 0o700, dir_fd=folder)
            default = os.open("Default", DIRECTORY, dir_fd=folder)
            try:
                fd = os.open("Preferences", os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE, 0o600, dir_fd=default)
                try:
                    os.write(fd, PREFERENCES)
                finally:
                    os.close(fd)
            finally:
                os.close(default)
        finally:
            os.close(folder)

    def remove(self, root, value):
        folder = self.profile(root, value)
        remaining = [100000]

        def empty(fd, depth):
            require(depth < 64)
            for name in os.listdir(fd):
                remaining[0] -= 1
                require(remaining[0] >= 0)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, DIRECTORY, dir_fd=fd)
                    try:
                        require(inode(os.fstat(child)) == inode(info))
                        empty(child, depth + 1)
                        require(inode(os.stat(name, dir_fd=fd, follow_symlinks=False)) == inode(info))
                        os.rmdir(name, dir_fd=fd)
                    finally:
                        os.close(child)
                else:
                    # Chromium uses singleton symlinks. Unlink them without following them.
                    os.unlink(name, dir_fd=fd)
        try:
            empty(folder, 0)
            require(inode(os.stat("profile-" + value["generation"], dir_fd=root, follow_symlinks=False)) == value["inode"])
            os.rmdir("profile-" + value["generation"], dir_fd=root)
            os.fsync(root)
        finally:
            os.close(folder)

    def rotate(self, task_id, recover=False):
        require(task_id is None if recover else isinstance(task_id, str) and TASK.fullmatch(task_id))
        with self.locked() as root:
            old = self.read(root)
            if old and not recover and old["phase"] == "ready" and old["taskId"] == task_id:
                os.close(self.profile(root, old))
                return {"taskId": task_id, "generation": old["generation"]}
            if old:
                old["phase"] = "retiring"
                self.write(root, old)
                for group in old["groups"]:
                    retire(group)
                # A crash after removing the old profile is safe to finish on recovery.
                try:
                    self.remove(root, old)
                except FileNotFoundError:
                    require(not os.path.lexists(os.path.join(self.root, "profile-" + old["generation"])))
            generation = uuid.uuid4().hex
            os.mkdir("profile-" + generation, 0o700, dir_fd=root)
            info = os.stat("profile-" + generation, dir_fd=root, follow_symlinks=False)
            current = {"version": 1, "taskId": task_id, "generation": generation,
                       "inode": inode(info), "phase": "ready", "groups": []}
            self.seed(root, current)
            self.write(root, current)
            return {"taskId": task_id, "generation": generation}

    def launch(self, arguments, command=("/usr/bin/chromium",)):
        arguments = with_start_page(arguments)
        require(len(arguments) <= 32 and sum(len(a.encode("utf-8")) for a in arguments) <= 8192)
        for arg in arguments:
            require(not any(ord(c) < 32 or ord(c) == 127 for c in arg))
            require(arg in ("--kiosk", "--new-window", "--incognito", "about:blank") or
                    arg.startswith(("https://", "http://", "file:///config/", "file:///opt/localdot/", "/config/", "/opt/localdot/")))
        child = None
        with self.locked() as root:
            state = self.read(root)
            require(state is not None and state["phase"] == "ready")
            os.close(self.profile(root, state))
            state["groups"] = [g for g in state["groups"] if members(g)]
            require(len(state["groups"]) < 32)
            profile = os.path.join(self.root, "profile-" + state["generation"])
            args = [*command, "--start-maximized", "--force-renderer-accessibility",
                    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
                    # Only this disposable, container-local development browser tolerates
                    # local TLS certificates. Chromium limits this to IsLocalhost URLs;
                    # public sites and the isolated saved-account browser stay strict.
                    "--allow-insecure-localhost",
                    "--disable-quic", "--no-first-run", "--no-default-browser-check",
                    "--user-data-dir=" + profile]
            if os.environ.get("HTTPS_PROXY"):
                args.append("--proxy-server=" + os.environ["HTTPS_PROXY"])
            args += arguments
            ready_read, ready_write = os.pipe()
            gate_read, gate_write = os.pipe()
            child = os.fork()
            if child == 0:
                try:
                    os.close(ready_read)
                    os.close(gate_write)
                    os.setsid()
                    os.write(ready_write, b"R")
                    os.close(ready_write)
                    require(os.read(gate_read, 1) == b"G")
                    os.close(gate_read)
                    env = {k: v for k, v in os.environ.items() if not k.startswith("LOCALDOT_DESKTOPD_") and k not in ("PASSWORD", "CUSTOM_USER")}
                    os.execve(command[0], args, env)
                except BaseException:
                    os._exit(126)
            os.close(ready_write)
            os.close(gate_read)
            try:
                require(select.select([ready_read], [], [], 3)[0] and os.read(ready_read, 1) == b"R")
                value = proc(child)
                require(value and value["group"] == child and value["session"] == child)
                state["groups"].append({"pid": child, "start": value["start"]})
                self.write(root, state)
                os.write(gate_write, b"G")
            except BaseException:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)
                raise
            finally:
                os.close(ready_read)
                os.close(gate_write)
        # A crashed launcher leaves a durable group record. Recovery includes surviving children.
        _, result = os.waitpid(child, 0)
        return os.waitstatus_to_exitcode(result)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "launch":
        return Profiles().launch(sys.argv[2:])
    require(len(sys.argv) == 2 and sys.argv[1] == "rotate")
    line = sys.stdin.buffer.read(1025)
    require(len(line) <= 1024)
    value = json.loads(line)
    require(isinstance(value, dict) and set(value) == {"taskId", "recover"} and type(value["recover"]) is bool)
    result = Profiles().rotate(value["taskId"], value["recover"])
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refused, OSError, ValueError):
        print("desktop browser could not be prepared", file=sys.stderr)
        sys.exit(1)
