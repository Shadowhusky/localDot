import json
import threading

import pytest

from conftest import (
    AUTH,
    RECEIVE_DEADLINE_S,
    WS_PROTOCOLS,
    WS_URL,
    FakeAligner,
    FakeSynth,
    cancel_and_wait,
    client,
    engines,
    say,
    slot,
    until_done,
)
from voiced.slots import ModelSlot
from voiced.visemes import build_track


def speak(app_engines, text="Hello there."):
    with client(app_engines).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        socket.send_text(json.dumps({"type": "say", "id": 1, "text": text, "lang": "en"}))
        socket.receive_bytes()
        socket.receive_bytes()
        assert socket.receive_json()["type"] == "end"
        return socket.receive_json()


def test_the_aligned_track_follows_the_end_of_each_sentence():
    aligner = FakeAligner()
    track = speak(engines(tts=slot(FakeSynth()), aligner=slot(aligner)))
    assert track == {
        "type": "track",
        "id": 1,
        "lang": "en",
        "visemes": [{"t": 0, "shape": "A"}, {"t": 50, "shape": "O"}, {"t": 100, "shape": "E"}, {"t": 200, "shape": "rest"}],
    }
    assert [call for call in aligner.calls if call[2] == "Hello there."] == [(4800, 24_000, "Hello there.", "en")]


def test_a_failed_alignment_is_named_so_the_page_keeps_the_envelope():
    failure = speak(engines(tts=slot(FakeSynth()), aligner=slot(FakeAligner(fail=True))))
    assert (failure["type"], failure["id"], failure["code"]) == ("error", 1, "align_failed")


def test_visemes_for_a_cloud_voices_own_timings():
    app = client(engines())
    body = {"lang": "zh", "units": [{"text": "你", "start": 0.0, "end": 0.16}, {"text": "好", "start": 0.16, "end": 0.4}]}
    assert app.post("/visemes", json=body, headers=AUTH).json() == {
        "visemes": [{"t": 0, "shape": "I"}, {"t": 160, "shape": "A"}, {"t": 400, "shape": "rest"}]
    }
    assert app.post("/visemes", json={"lang": "fr", "units": []}, headers=AUTH).status_code == 400
    assert app.post("/visemes", json={"lang": "en", "units": [{"text": "x"}]}, headers=AUTH).status_code == 400
    assert app.post("/visemes", json=body).status_code == 401


@pytest.mark.parametrize("fail", [False, True], ids=["track", "failure"])
def test_nothing_of_a_cancelled_sentence_follows_the_cancel_not_even_its_track(fail):
    gate = threading.Event()
    app_engines = engines(tts=slot(FakeSynth()), aligner=slot(FakeAligner(fail=fail, gate=gate, held="First.")))
    with client(app_engines).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1, "First.")
        assert until_done(socket, 1) == [(1, "audio"), (1, "audio"), (1, "end")]
        cancel_and_wait(socket)
        gate.set()
        say(socket, 2, "Second.")
        after = until_done(socket, 2, last=("track", "error"))
    assert [kind for sentence_id, kind in after if sentence_id == 1] == []
    assert after[-1] == (2, "error" if fail else "track")


def test_the_aligner_loads_right_after_the_voice_as_a_session_opens():
    loads: list[str] = []
    warmed = threading.Event()

    def load_voice() -> FakeSynth:
        loads.append("tts")
        return FakeSynth()

    def load_aligner() -> FakeAligner:
        loads.append("aligner")
        warmed.set()
        return FakeAligner()

    app_engines = engines(tts=ModelSlot(load_voice, idle_unload_s=600), aligner=ModelSlot(load_aligner, idle_unload_s=600))
    with client(app_engines).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        assert socket.receive_json() == {"type": "ready", "voice": "stock"}
        assert warmed.wait(RECEIVE_DEADLINE_S)
    assert loads == ["tts", "aligner"]


def test_an_aligner_that_will_not_load_leaves_the_voice_speaking():
    attempts = []

    def load_aligner() -> FakeAligner:
        attempts.append(1)
        raise OSError("not in the cache")

    app_engines = engines(tts=slot(FakeSynth()), aligner=ModelSlot(load_aligner, idle_unload_s=600))
    with client(app_engines).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        assert until_done(socket, 1) == [(1, "audio"), (1, "audio"), (1, "end")]
        failure = socket.receive_json()
    assert failure == {"type": "error", "id": 1, "code": "align_failed", "message": "OSError: not in the cache"}
    assert len(attempts) == 2


def test_a_voice_that_will_not_load_leaves_the_aligner_unloaded():
    aligner_loads = []

    def load_aligner() -> FakeAligner:
        aligner_loads.append(1)
        return FakeAligner()

    refused = slot(FakeSynth(), guard=lambda: "LM Studio has qwen3.6-35b loaded (44.5 GB)")
    app_engines = engines(tts=refused, aligner=ModelSlot(load_aligner, idle_unload_s=600))
    with client(app_engines).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        assert socket.receive_json()["code"] == "unavailable"
        say(socket, 1)
        assert socket.receive_json()["code"] == "unavailable"
    assert aligner_loads == []


def test_each_languages_front_end_warms_up_with_the_aligner(monkeypatch):
    built: list[tuple[str, str]] = []

    def noting_build_track(units, lang):
        built.append((lang, threading.current_thread().name))
        return build_track(units, lang)

    monkeypatch.setattr("voiced.align.build_track", noting_build_track)
    aligner = FakeAligner()
    with client(engines(tts=slot(FakeSynth()), aligner=slot(aligner))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        assert until_done(socket, 1, last=("track", "error"))[-1] == (1, "track")
    warm_ups, sentence = aligner.calls[:-1], aligner.calls[-1]
    assert [lang for _, _, _, lang in warm_ups] == ["zh", "ja", "en"] and sentence[2] == "Hello there."
    assert all(size <= rate for size, rate, _, _ in warm_ups)
    assert [lang for lang, _ in built] == ["zh", "ja", "en"]
    assert {name.rsplit("_", 1)[0] for _, name in built} == {"voiced-model"}


def test_visemes_refuse_times_that_are_not_finite():
    app = client(engines())
    headers = {**AUTH, "content-type": "application/json"}
    for start, end in (("NaN", "0.2"), ("0", "Infinity"), ("-Infinity", "0.2")):
        body = f'{{"lang": "en", "units": [{{"text": "hi", "start": {start}, "end": {end}}}]}}'
        assert app.post("/visemes", content=body, headers=headers).status_code == 400, (start, end)
