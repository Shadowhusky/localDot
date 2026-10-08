"""Synthetic browser session with a profile, cookie and surviving child; no network."""
import json
import os
from pathlib import Path
import signal
import sys
import time

profile = Path(next(a.split("=", 1)[1] for a in sys.argv if a.startswith("--user-data-dir=")))
if os.environ.get("LOCALDOT_PROFILE_TEST_MODE") == "survivor":
    child = os.fork()
    if child:
        os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
(profile / "ready.json").write_text(json.dumps({"pid": os.getpid(), "args": sys.argv,
    "secretInherited": "LOCALDOT_DESKTOPD_TOKEN" in os.environ, "cookie": "synthetic-cookie"}))
while True:
    time.sleep(0.1)
