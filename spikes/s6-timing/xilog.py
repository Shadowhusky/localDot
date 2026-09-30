"""Stream XI2 raw input events from the desktop's X server as JSON lines, and answer clock pings.

Run inside the desktop as the desktop user: python3 -u xilog.py
Each raw event: {"type", "device", "detail", "xtime" (X server ms), "real" (CLOCK_REALTIME ms), "mono" (CLOCK_MONOTONIC ms)}.
Each stdin line <id> is answered with {"pong": <id>, "real", "mono"} so the caller can estimate the clock offset.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

lock = threading.Lock()


def emit(obj):
    with lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def answer_pings():
    for line in iter(sys.stdin.readline, ""):
        emit({"pong": line.strip(), "real": time.time_ns() / 1e6, "mono": time.monotonic_ns() / 1e6})
    xi.kill()
    os._exit(0)


xi = subprocess.Popen(["stdbuf", "-oL", "xinput", "test-xi2", "--root"], stdout=subprocess.PIPE, text=True)
threading.Thread(target=answer_pings, daemon=True).start()
event = None
for line in xi.stdout:
    if line.startswith("EVENT type"):
        real, mono = time.time_ns() / 1e6, time.monotonic_ns() / 1e6
        m = re.match(r"EVENT type \d+ \((Raw\w+)\)", line)
        event = {"type": m.group(1), "real": real, "mono": mono} if m else None
        continue
    if event is None:
        continue
    key, _, value = line.strip().partition(":")
    if key == "device":
        event["device"] = value.strip()
    elif key == "time":
        event["xtime"] = int(value)
    elif key == "detail":
        event["detail"] = int(value)
        emit(event)
        event = None
