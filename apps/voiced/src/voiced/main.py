"""Entry point: `uv run voiced`, started and stopped by the localDot host."""

import os
import sys
import threading
import time

import uvicorn

from voiced.app import create_app
from voiced.config import ConfigError, Settings
from voiced.engines import mlx_engines


def watch_parent(pid: int | None, every_s: float = 2.0) -> None:
    """Exit once the host that started voiced is gone, so no orphan keeps the port."""
    if pid is None:
        return

    def watch() -> None:
        while True:
            time.sleep(every_s)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                os._exit(0)
            except PermissionError:
                pass

    threading.Thread(target=watch, name="voiced-parent-watch", daemon=True).start()


def main() -> None:
    try:
        settings = Settings.from_env()
    except ConfigError as problem:
        print(f"voiced: {problem}", file=sys.stderr)
        raise SystemExit(2) from None
    watch_parent(settings.parent_pid)
    app = create_app(settings, mlx_engines(settings))
    uvicorn.run(app, host="127.0.0.1", port=settings.port, ws="websockets-sansio", log_level="warning")
