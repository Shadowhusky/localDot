import asyncio

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import AUTH, TOKEN, WS_URL, client, engines, slot
from voiced.app import create_app, sweep_forever
from voiced.config import Settings
from voiced.worker import Worker


def test_health_needs_the_token_and_reports_each_model():
    app = client(engines(tts=slot("model")))
    assert app.get("/health").status_code == 401
    assert app.get("/health", headers={**AUTH, "origin": "http://127.0.0.1:4753"}).status_code == 403
    assert app.get("/health", headers=AUTH).json() == {
        "ok": True,
        "voice": "stock",
        "slots": {"tts": {"state": "idle", "reason": None}},
    }


def test_health_refuses_a_rebound_host():
    rebound = TestClient(create_app(Settings(token=TOKEN), engines()), base_url="http://attacker.example:4752")
    assert rebound.get("/health", headers=AUTH).status_code == 403


def test_websockets_are_refused_before_they_open():
    app = client(engines(tts=slot("model")))
    with pytest.raises(WebSocketDisconnect) as refused:
        with app.websocket_connect(f"{WS_URL}/tts", subprotocols=["localdot.v1"]):
            pass
    assert refused.value.code == 4401
    with pytest.raises(WebSocketDisconnect) as foreign:
        with app.websocket_connect(f"{WS_URL}/tts", headers={**AUTH, "origin": "http://evil.example"}):
            pass
    assert foreign.value.code == 4403


class FlakySweeps:
    """Engines whose first sweep fails outright."""

    def __init__(self) -> None:
        self.sweeps = 0

    def sweep(self) -> list[str]:
        self.sweeps += 1
        if self.sweeps == 1:
            raise RuntimeError("sweep fell over")
        return []


def test_a_failing_sweep_is_logged_and_the_next_one_still_runs(monkeypatch, caplog):
    monkeypatch.setattr("voiced.app.SWEEP_EVERY_S", 0)
    flaky = FlakySweeps()

    async def sweep_twice() -> None:
        worker = Worker()
        sweeper = asyncio.create_task(sweep_forever(flaky, worker))
        while flaky.sweeps < 2 and not sweeper.done():
            await asyncio.sleep(0.001)
        sweeper.cancel()
        worker.close()

    asyncio.run(asyncio.wait_for(sweep_twice(), 2))
    assert flaky.sweeps >= 2
    assert "model sweep failed" in caplog.text and "RuntimeError: sweep fell over" in caplog.text
