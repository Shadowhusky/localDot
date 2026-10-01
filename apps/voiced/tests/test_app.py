from starlette.testclient import TestClient

from conftest import AUTH, TOKEN, client, engines, slot
from voiced.app import create_app
from voiced.config import Settings


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
