import threading
import time
from collections.abc import Iterator

import anyio
import numpy as np
import pytest
from starlette.testclient import TestClient, WebSocketTestSession
from starlette.types import Message

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
RECEIVE_DEADLINE_S = 2.0


def _receive_by_deadline(self: WebSocketTestSession) -> Message:
    async def receive() -> Message:
        with anyio.fail_after(RECEIVE_DEADLINE_S):
            return await self._send_rx.receive()

    return self.portal.call(receive)


@pytest.fixture(autouse=True)
def receive_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    """A socket that never answers fails its test fast instead of hanging the suite."""
    monkeypatch.setattr(WebSocketTestSession, "receive", _receive_by_deadline)


def slot(value: object, guard=None) -> ModelSlot:
    return ModelSlot(lambda: value, idle_unload_s=600, guard=guard)


def engines(**slots: ModelSlot) -> Engines:
    return Engines(voice="stock", slots=slots)


def client(app_engines: Engines) -> TestClient:
    return TestClient(create_app(Settings(token=TOKEN), app_engines), base_url=BASE_URL)


class FakeSynth:
    """Alternating ±0.5 chunks of 0.1 s; can fail at a chunk, garble one, or take its time per chunk.

    With a gate, every chunk after the first waits for it to open. `decoded` names each chunk's sentence;
    `threads` names the thread that ran each step of a stream, its close included.
    """

    sample_rate = 24_000

    def __init__(
        self,
        chunks: int = 2,
        fail_at: int | None = None,
        delay_s: float = 0.0,
        garbled_at: int | None = None,
        gate: threading.Event | None = None,
    ) -> None:
        self.chunks = chunks
        self.fail_at = fail_at
        self.delay_s = delay_s
        self.garbled_at = garbled_at
        self.gate = gate
        self.spoken: list[tuple[str, str]] = []
        self.decoded: list[str] = []
        self.threads: list[str] = []

    def stream(self, text: str, lang: str) -> Iterator[np.ndarray]:
        self.spoken.append((text, lang))
        try:
            for i in range(self.chunks):
                self.threads.append(threading.current_thread().name)
                if i > 0 and self.gate is not None:
                    self.gate.wait(RECEIVE_DEADLINE_S)
                if self.fail_at == i:
                    raise RuntimeError("model fell over")
                time.sleep(self.delay_s)
                self.decoded.append(text)
                if self.garbled_at == i:
                    yield np.array(["static"])
                else:
                    yield np.full(2400, 0.5 if i % 2 == 0 else -0.5, dtype=np.float32)
        finally:
            self.threads.append(threading.current_thread().name)
