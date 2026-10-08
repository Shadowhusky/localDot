"""Fixed diagnostic exercise, run only inside the parent's owned desktop.

This program never receives the synthetic upstream secret. The separate scanner
receives it only after this exec has exited. Successful controls intentionally
stay alive until the parent stops the whole owned container; an exec disconnect
is not proof of retirement. The parent must bound and drain every exec.
"""

import base64
import http.client
import json
import os
import re
import selectors
import signal
import ssl
import subprocess
import sys
import time

HOST = "canary.localdot.invalid"
MAX_BODY = 65536
CHILD_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": ":1"}


def controls(marker, clipboard, surrogate, challenge):
    for value, pattern in (
        (marker, r"control-[0-9a-f]{32}"),
        (clipboard, r"clipboard-[0-9a-f]{32}"),
        (surrogate, r"ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}"),
        (challenge, r"[0-9a-f]{32}"),
    ):
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError("invalid control")
    return "/tmp/localdot-canary-" + marker


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def reflected_response(surrogate, challenge):
    # Connect only to the desktop's normal local forwarder, never DNS or a
    # caller-supplied endpoint. HTTPSConnection tunnels before verifying the
    # upstream certificate against the desktop's normal installed trust store.
    context = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")
    connection = http.client.HTTPSConnection("127.0.0.1", 3129, timeout=8, context=context)
    try:
        connection.set_tunnel(HOST, 443)
        connection.request("GET", "/v1/canary/" + challenge, headers={
            "Host": HOST,
            "Authorization": "Bearer " + surrogate,
            "Connection": "close",
        })
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("unexpected response")
        headers = response.getheaders()
        for name, expected in (("x-canary-key", surrogate), ("content-type", "application/json")):
            if [value for key, value in headers if key.lower() == name] != [expected]:
                raise ValueError("invalid reflection header")
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError("response too large")
        expected = {
            "challenge": challenge,
            "authorization": "Bearer " + surrogate,
            "base64": base64.b64encode(surrogate.encode()).decode(),
            "hex": surrogate.encode().hex(),
        }
        if json.loads(body.decode("utf-8"), object_pairs_hook=unique_object) != expected:
            raise ValueError("invalid reflection body")
        return body
    finally:
        connection.close()


def write_controls(directory, marker, body):
    # mkdir is exclusive. Never overwrite a prior run's directory or follow a
    # pre-existing link. All children are fixed regular files created once.
    os.mkdir(directory, 0o700)
    raw = marker.encode()
    values = [("raw", raw)]
    for label, encode in (("base64", base64.b64encode), ("base64url", base64.urlsafe_b64encode)):
        for shift in range(3):
            form = label + ("+" + str(shift) if shift else "")
            values.append((form, encode(b"\0" * shift + raw)))
    values.extend((("hex", raw.hex().encode()), ("HEX", raw.hex().upper().encode()),
                   ("utf16le", marker.encode("utf-16-le"))))
    files = []
    for index, (name, data) in enumerate([*values, ("reflection.json", body)]):
        path = directory + "/" + (name if name == "reflection.json" else str(index) + "-" + name)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
        if name != "reflection.json":
            files.append({"form": name, "path": path})
    return files


def start_holder(marker, surrogate):
    return subprocess.Popen([marker, "540"], executable="/bin/sleep", env={
        **CHILD_ENV, "LOCALDOT_MARKER": marker, "LOCALDOT_SURROGATE": surrogate,
    }, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        close_fds=True)


def start_clipboard(payload):
    child = subprocess.Popen(["/usr/bin/xclip", "-quiet", "-selection", "clipboard", "-loops", "0"],
                             env=CHILD_ENV, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, close_fds=True)
    try:
        child.stdin.write(payload)
        child.stdin.close()
        # X selection ownership is asynchronous. Read-back is bounded and must
        # match all bytes; the later scanner separately proves xclip memory.
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise ValueError("clipboard owner exited")
            if read_clipboard() == payload:
                return child
            time.sleep(0.05)
        raise ValueError("clipboard did not become ready")
    except BaseException:
        child.stdin.close()
        retire_child(child)
        raise


def read_clipboard():
    child = subprocess.Popen(["/usr/bin/xclip", "-o", "-selection", "clipboard"],
                             env=CHILD_ENV, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
    deadline = time.monotonic() + 2
    chunks = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("clipboard read timed out")
                data = os.read(child.stdout.fileno(), min(8192, MAX_BODY + 129 - len(chunks)))
                chunks.extend(data)
                if len(chunks) > MAX_BODY + 128:
                    raise ValueError("clipboard too large")
                if not data:
                    break
        if child.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
            return None
        return bytes(chunks)
    finally:
        retire_child(child)
        child.stdout.close()


def retire_child(child):
    if child.poll() is None:
        child.kill()
    child.wait(timeout=3)


def exercise(marker, clipboard, surrogate, challenge):
    directory = controls(marker, clipboard, surrogate, challenge)
    body = reflected_response(surrogate, challenge)
    files = write_controls(directory, marker, body)
    children = []
    try:
        children.append(start_holder(marker, surrogate))
        children.append(start_clipboard(body + b"\n" + clipboard.encode()))
        if any(child.poll() is not None for child in children):
            raise ValueError("control exited")
        return {"v": 1, "type": "exercised", "challenge": challenge, "files": files}
    except BaseException:
        for child in children:
            retire_child(child)
        raise


def tmpfs_roots(mounts):
    if len(mounts) > 1024 * 1024:
        raise ValueError("mount table too large")
    paths = {"/config"}
    for line in mounts.splitlines():
        fields = line.split()
        if len(fields) != 6:
            raise ValueError("invalid mount table")
        if fields[2] != "tmpfs":
            continue
        path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[1])
        if (len(path.encode()) > 4096 or "\0" in path or not path.startswith("/")
                or path == "/" or any(part in ("", ".", "..") for part in path.split("/")[1:])):
            raise ValueError("invalid mount path")
        if not any(path == root or path.startswith(root + "/") for root in ("/proc", "/sys")):
            paths.add(path)
        if len(paths) > 4096:
            raise ValueError("too many mounts")
    return sorted(paths)


def main(args):
    # Accidental invocation on the developer's host must never inspect process
    # memory or modify its clipboard. Ownership/image checks remain the parent's
    # responsibility; this marker is only an additional execution guard.
    if sys.platform != "linux" or not os.path.isfile("/.dockerenv"):
        raise ValueError("desktop required")
    def timeout(_signum, _frame):
        raise TimeoutError("exercise timed out")

    previous = signal.signal(signal.SIGALRM, timeout)
    signal.alarm(30)
    try:
        if len(args) == 5 and args[0] == "exercise":
            result = exercise(*args[1:])
        elif args == ["roots"]:
            with open("/proc/mounts", encoding="utf-8", errors="strict") as source:
                result = {"v": 1, "type": "roots", "paths": tmpfs_roots(source.read(1024 * 1024 + 1))}
        else:
            raise ValueError("invalid mode")
        print(json.dumps(result, separators=(",", ":")))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        # Response bytes and process errors can contain diagnostic needles. They
        # stay out of command errors/logs even when reflection was not scrubbed.
        print("Diagnostic exercise failed.", file=sys.stderr)
        sys.exit(1)
