import time
from collections.abc import Iterator

import numpy as np
from starlette.testclient import TestClient

from voiced.app import create_app
from voiced.config import Settings
from voiced.engines import Engines
from voiced.slots import ModelSlot

TOKEN = "t" * 43
BASE_URL = "http://127.0.0.1:4752"
# websocket_connect ignores base_url for relative paths, so sockets use this absolute form.
WS_URL = "ws://127.0.0.1:4752"
AUTH = {"authorization": f"Bearer {TOKEN}"}
WS_PROTOCOLS = ["localdot.v1", f"localdot.token.{TOKEN}"]


def slot(value: object, guard=None) -> ModelSlot:
    return ModelSlot(lambda: value, idle_unload_s=600, guard=guard)


def engines(**slots: ModelSlot) -> Engines:
    return Engines(voice="stock", slots=slots)


def client(app_engines: Engines) -> TestClient:
    return TestClient(create_app(Settings(token=TOKEN), app_engines), base_url=BASE_URL)


class FakeSynth:
    """Alternating ±0.5 chunks of 0.1 s; can fail at a chunk or take its time per chunk."""

    sample_rate = 24_000

    def __init__(self, chunks: int = 2, fail_at: int | None = None, delay_s: float = 0.0) -> None:
        self.chunks = chunks
        self.fail_at = fail_at
        self.delay_s = delay_s
        self.spoken: list[tuple[str, str]] = []

    def stream(self, text: str, lang: str) -> Iterator[np.ndarray]:
        self.spoken.append((text, lang))
        for i in range(self.chunks):
            if self.fail_at == i:
                raise RuntimeError("model fell over")
            time.sleep(self.delay_s)
            yield np.full(2400, 0.5 if i % 2 == 0 else -0.5, dtype=np.float32)
