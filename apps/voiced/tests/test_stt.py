import asyncio
import json
import threading
import time

import numpy as np
from starlette.types import Message
from starlette.websockets import WebSocketDisconnect

from conftest import WS_PROTOCOLS, WS_URL, FakeProbe, FakeRecognizer, FakeSynth, ThreadNotingSlot, client, engines, say, slot
from voiced.slots import ModelSlot
from voiced.stt import SttSession, join_texts
from voiced.worker import Worker

CHUNK = 480


def pcm(seconds: float, loud: bool) -> bytes:
    return np.full(round(seconds * 16_000), 9830 if loud else 0, dtype="<i2").tobytes()


def stream(socket, *parts: tuple[float, bool]) -> None:
    audio = b"".join(pcm(s, loud) for s, loud in parts)
    for i in range(0, len(audio), CHUNK * 2):
        socket.send_bytes(audio[i : i + CHUNK * 2])


def listening(recognizer=None, asr=None):
    asr = asr or slot(recognizer or FakeRecognizer())
    return client(engines(asr=asr, vad=slot(FakeProbe))).websocket_connect(f"{WS_URL}/stt", subprotocols=WS_PROTOCOLS)


def until(socket, kind):
    seen = []
    while True:
        message = socket.receive_json()
        seen.append(message)
        if message["type"] == kind:
            return seen


def test_push_to_talk_decodes_everything_from_press_to_release():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        assert socket.receive_json() == {"type": "ready"}
        stream(socket, (1.0, True), (0.2, False))
        socket.send_text(json.dumps({"type": "release"}))
        seen = until(socket, "end")
    kinds = [m["type"] for m in seen]
    assert kinds[0] == "speech_started" and kinds[-2:] == ["final", "end"]
    assert seen[-1] == {"type": "end", "utterance": 1, "text": "1.2s", "lang": "en"}
    assert "partial" in kinds


def test_hands_free_ends_a_turn_after_half_a_second_and_the_utterance_after_a_second():
    with listening() as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.4, False), (1.0, True), (1.2, False))
        seen = until(socket, "end")
    finals = [m for m in seen if m["type"] == "final"]
    assert seen[0] == {"type": "speech_started", "utterance": 1}
    assert len(finals) == 1 and finals[0]["text"] == seen[-1]["text"] == "1.82s"


def test_a_pause_under_a_second_keeps_one_utterance_and_decodes_each_turn_once():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.6, True), (0.7, False), (0.6, True), (1.2, False))
        seen = until(socket, "end")
    finals = [m["text"] for m in seen if m["type"] == "final"]
    assert [m["utterance"] for m in seen if m["type"] == "speech_started"] == [1, 1]
    assert finals == ["1.12s", "1.12s 1.31s"] and seen[-1]["text"] == finals[1]


def test_a_long_pause_starts_a_second_utterance():
    with listening() as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.5, True), (1.2, False), (0.5, True), (1.2, False))
        first = until(socket, "end")
        second = until(socket, "end")
    assert (first[-1]["utterance"], second[-1]["utterance"]) == (1, 2)


def test_a_refused_speech_model_is_reported_on_listen():
    refused = slot(FakeRecognizer(), guard=lambda: "LM Studio has big loaded (44.5 GB)")
    with listening(asr=refused) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        reply = socket.receive_json()
    assert (reply["type"], reply["code"]) == ("error", "unavailable")


def test_audio_before_listen_is_ignored():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        stream(socket, (1.0, True), (1.2, False))
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        assert socket.receive_json() == {"type": "ready"}
    assert recognizer.heard == []


def test_joins_turns_without_spaces_between_cjk_text():
    assert join_texts(["你好。", "我在。"]) == "你好。我在。"
    assert join_texts(["Hello.", "我在。", "OK"]) == "Hello. 我在。 OK"
    assert join_texts(["", " hi "]) == "hi"


LISTEN_PTT = json.dumps({"type": "listen", "mode": "ptt"})
LISTEN_HANDSFREE = json.dumps({"type": "listen", "mode": "handsfree"})
RELEASE = json.dumps({"type": "release"})


class FailingRecognizer(FakeRecognizer):
    """Fails its first `failures` decodes."""

    def __init__(self, failures: int = 1) -> None:
        super().__init__()
        self.failures = failures

    def transcribe(self, audio):
        if self.failures:
            self.failures -= 1
            raise RuntimeError("decoder fell over")
        return super().transcribe(audio)


class BrokenProbe(FakeProbe):
    """Hears speech, then falls over at frame `fail_at`."""

    def __init__(self, fail_at: int) -> None:
        self.fail_at = fail_at
        self.frames = 0

    def probability(self, frame):
        self.frames += 1
        if self.frames > self.fail_at:
            raise RuntimeError("detector fell over")
        return super().probability(frame)


def test_an_unexpected_failure_while_loading_is_reported_and_the_session_carries_on(caplog):
    checks = []

    def check() -> None:
        checks.append(1)
        if len(checks) == 1:
            raise RuntimeError("the load check fell over")

    with listening(asr=slot(FakeRecognizer(), guard=check)) as socket:
        socket.send_text(LISTEN_PTT)
        failure = socket.receive_json()
        socket.send_text(LISTEN_PTT)
        ready = socket.receive_json()
        stream(socket, (0.5, True))
        socket.send_text(RELEASE)
        end = until(socket, "end")[-1]
    assert failure == {"type": "error", "code": "unavailable", "message": "RuntimeError: the load check fell over"}
    assert ready == {"type": "ready"} and end == {"type": "end", "utterance": 1, "text": "0.5s", "lang": "en"}
    assert "the load check fell over" in caplog.text


def test_a_failed_decode_is_reported_in_place_of_its_text_and_listening_carries_on(caplog):
    with listening(FailingRecognizer()) as socket:
        socket.send_text(LISTEN_PTT)
        socket.receive_json()
        stream(socket, (1.0, True), (0.2, False))
        socket.send_text(RELEASE)
        seen = until(socket, "end")
    assert [m["type"] for m in seen] == ["speech_started", "error", "final", "end"]
    assert seen[1] == {"type": "error", "code": "recognition_failed", "message": "RuntimeError: decoder fell over"}
    assert seen[-1]["text"] == "1.2s"
    assert "decoder fell over" in caplog.text


def test_a_failing_voice_detector_is_reported_once_and_its_utterance_dropped(caplog):
    probes = iter([BrokenProbe(fail_at=9), FakeProbe()])
    app_engines = engines(asr=slot(FakeRecognizer()), vad=slot(lambda: next(probes)))
    with client(app_engines).websocket_connect(f"{WS_URL}/stt", subprotocols=WS_PROTOCOLS) as socket:
        socket.send_text(LISTEN_HANDSFREE)
        socket.receive_json()
        stream(socket, (0.3, True))
        seen = until(socket, "speech_started")
        stream(socket, (0.7, True), (1.2, False))
        socket.send_text(LISTEN_HANDSFREE)
        seen += until(socket, "ready")
        stream(socket, (0.5, True), (1.2, False))
        seen += until(socket, "end")
    assert seen[:3] == [
        {"type": "speech_started", "utterance": 1},
        {"type": "error", "code": "recognition_failed", "message": "RuntimeError: detector fell over"},
        {"type": "ready"},
    ]
    assert {m.get("utterance") for m in seen[3:]} == {2}
    assert "detector fell over" in caplog.text


def test_audio_that_is_not_whole_samples_is_refused_while_listening():
    with listening() as socket:
        socket.send_text(LISTEN_PTT)
        socket.receive_json()
        socket.send_bytes(b"\x01\x02\x03")
        reply = socket.receive_json()
    assert reply == {"type": "error", "code": "bad_request", "message": "audio must be whole 16-bit samples"}


def test_listening_again_drops_the_open_utterance_without_a_word():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        socket.send_text(LISTEN_HANDSFREE)
        socket.receive_json()
        stream(socket, (0.4, True))
        socket.send_text(LISTEN_HANDSFREE)
        before = until(socket, "ready")
        stream(socket, (0.5, True), (1.2, False))
        after = until(socket, "end")
    assert before == [{"type": "speech_started", "utterance": 1}, {"type": "ready"}]
    assert {m["utterance"] for m in after} == {2}
    assert after[-1]["text"] == "1.02s" and recognizer.heard[-1] == 1.02


def test_audio_after_an_utterance_ends_in_the_same_chunk_starts_the_next():
    with listening() as socket:
        socket.send_text(LISTEN_HANDSFREE)
        socket.receive_json()
        socket.send_bytes(b"".join(pcm(s, loud) for s, loud in [(0.5, True), (1.2, False), (0.5, True), (1.2, False)]))
        seen = until(socket, "end")
        seen += until(socket, "end")
    assert [(m["utterance"], m["text"]) for m in seen if m["type"] == "end"] == [(1, "1.02s"), (2, "1.18s")]


def test_an_idle_unload_between_utterances_frees_the_speech_model():
    now = [0.0]
    loads = []

    def load() -> FakeRecognizer:
        loads.append(1)
        return FakeRecognizer()

    asr = ModelSlot(load, idle_unload_s=600, clock=lambda: now[0])
    with listening(asr=asr) as socket:
        socket.send_text(LISTEN_HANDSFREE)
        socket.receive_json()
        stream(socket, (0.5, True), (1.2, False))
        until(socket, "end")
        now[0] += 601
        assert asr.sweep()
        stream(socket, (0.5, True), (1.2, False))
        until(socket, "end")
    assert len(loads) == 2 and asr.state == "ready"


def test_every_model_call_runs_on_the_model_thread():
    threads: list[str] = []

    class Recognizer(FakeRecognizer):
        def transcribe(self, audio):
            threads.append(threading.current_thread().name)
            return super().transcribe(audio)

    class Probe(FakeProbe):
        def __init__(self) -> None:
            threads.append(threading.current_thread().name)

        def probability(self, frame):
            threads.append(threading.current_thread().name)
            return super().probability(frame)

    app_engines = engines(asr=ThreadNotingSlot(Recognizer(), threads), vad=ThreadNotingSlot(Probe, threads))
    with client(app_engines).websocket_connect(f"{WS_URL}/stt", subprotocols=WS_PROTOCOLS) as socket:
        socket.send_text(LISTEN_PTT)
        socket.receive_json()
        stream(socket, (1.0, True), (0.2, False))
        socket.send_text(RELEASE)
        until(socket, "end")
    assert len(threads) > 40
    assert {name.rsplit("_", 1)[0] for name in threads} == {"voiced-model"}


class PageThatLeaves:
    """Plays its script, and is gone by the time the server sends its first message of kind `leaves_on`."""

    def __init__(self, script: list[Message], leaves_on: str) -> None:
        self.script = script
        self.leaves_on = leaves_on
        self.sent: list[dict] = []
        self.gone = False

    async def receive(self) -> Message:
        return self.script.pop(0) if self.script else {"type": "websocket.disconnect", "code": 1000}

    async def send_json(self, message: dict) -> None:
        if message["type"] == self.leaves_on and not self.gone:
            self.gone = True
            raise WebSocketDisconnect(1006)
        self.sent.append(message)


def test_the_session_ends_quietly_once_the_page_has_gone():
    page = PageThatLeaves(
        [
            {"type": "websocket.receive", "text": LISTEN_PTT},
            {"type": "websocket.receive", "bytes": pcm(1.0, True)},
            {"type": "websocket.receive", "text": RELEASE},
            {"type": "websocket.receive", "text": LISTEN_PTT},
        ],
        leaves_on="final",
    )
    worker = Worker()
    try:
        asyncio.run(asyncio.wait_for(SttSession(page, engines(asr=slot(FakeRecognizer()), vad=slot(FakeProbe)), worker).run(), 2))
    finally:
        worker.close()
    assert [m["type"] for m in page.sent] == ["ready", "speech_started", "partial"]


def test_speech_input_keeps_up_while_the_voice_model_is_busy():
    synth = FakeSynth(chunks=60, delay_s=0.05)
    app_engines = engines(tts=slot(synth), asr=slot(FakeRecognizer()), vad=slot(FakeProbe))
    with client(app_engines) as shared:
        with (
            shared.websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as speaking,
            shared.websocket_connect(f"{WS_URL}/stt", subprotocols=WS_PROTOCOLS) as socket,
        ):
            speaking.receive_json()
            say(speaking, 1, "A long reply.")
            speaking.receive_bytes()
            socket.send_text(LISTEN_PTT)
            socket.receive_json()
            stream(socket, (1.0, True), (0.2, False))
            released = time.perf_counter()
            socket.send_text(RELEASE)
            end = until(socket, "end")[-1]
            waited = time.perf_counter() - released
    assert end["text"] == "1.2s" and waited < 0.6


def test_a_blip_of_one_or_two_frames_does_not_interrupt_her():
    with listening() as socket:
        socket.send_text(LISTEN_HANDSFREE)
        socket.receive_json()
        stream(socket, (0.032, True), (0.32, False), (0.064, True), (1.216, False))
        socket.send_text(LISTEN_HANDSFREE)
        assert socket.receive_json() == {"type": "ready"}
        stream(socket, (0.096, True), (1.216, False))
        assert socket.receive_json() == {"type": "speech_started", "utterance": 1}
