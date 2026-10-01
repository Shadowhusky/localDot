import asyncio

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import AUTH, TOKEN, WS_URL, client, engines, slot
from voiced.app import create_app, sweep_forever
from voiced.config import Settings
from voiced.slots import ModelSlot
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


def test_a_failing_sweep_is_logged_and_idle_models_still_unload(monkeypatch, caplog):
    monkeypatch.setattr("voiced.app.SWEEP_EVERY_S", 0)

    def broken_release() -> None:
        raise RuntimeError("release failed")

    stuck = ModelSlot(lambda: "aligner", 0, release=broken_release)
    idle = ModelSlot(lambda: "tts", 0, release=lambda: None)
    stuck.get()
    idle.get()

    async def sweep_until_unloaded() -> None:
        worker = Worker()
        sweeper = asyncio.create_task(sweep_forever(engines(aligner=stuck, tts=idle), worker))
        while idle.state == "ready" and not sweeper.done():
            await asyncio.sleep(0.001)
        sweeper.cancel()
        worker.close()

    asyncio.run(asyncio.wait_for(sweep_until_unloaded(), 2))
    assert idle.state == "idle"
    assert "model sweep failed" in caplog.text and "RuntimeError: release failed" in caplog.text
