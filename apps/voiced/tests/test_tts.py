import json
import threading

import pytest

from conftest import (
    RECEIVE_DEADLINE_S,
    WS_PROTOCOLS,
    WS_URL,
    FakeSynth,
    cancel_and_wait,
    client,
    engines,
    frame,
    say,
    slot,
    until_done,
)
from voiced.slots import ModelSlot


class ThreadNotingSlot(ModelSlot):
    """Notes the thread of every get."""

    def __init__(self, value: object, threads: list[str]) -> None:
        super().__init__(lambda: value, idle_unload_s=600)
        self.threads = threads

    def get(self) -> object:
        self.threads.append(threading.current_thread().name)
        return super().get()


def test_greets_with_the_voice_then_streams_a_sentence_and_its_end():
    synth = FakeSynth()
    with client(engines(tts=slot(synth))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        assert socket.accepted_subprotocol == "localdot.v1"
        assert socket.receive_json() == {"type": "ready", "voice": "stock"}
        say(socket, 3, "  Hello\nthere.  ")
        first, second = frame(socket.receive_bytes()), frame(socket.receive_bytes())
        assert (first[0], first[1], first[2][:2]) == (3, 0, [16384, 16384])
        assert (second[0], second[1], second[2][:2]) == (3, 1, [-16384, -16384])
        assert socket.receive_json() == {"type": "end", "id": 3, "samples": 4800}
    assert synth.spoken == [("Hello there.", "en")]


def test_a_refused_model_makes_the_sentence_unavailable():
    refused = slot(FakeSynth(), guard=lambda: "LM Studio has qwen3.6-35b loaded (44.5 GB)")
    with client(engines(tts=refused)).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        early = socket.receive_json()
        say(socket, 1)
        reply = socket.receive_json()
    assert early == {"type": "error", "id": None, "code": "unavailable", "message": "LM Studio has qwen3.6-35b loaded (44.5 GB)"}
    assert (reply["type"], reply["id"], reply["code"]) == ("error", 1, "unavailable")
    assert "44.5 GB" in reply["message"]


def test_bad_sentences_are_refused_by_name():
    synth = FakeSynth()
    with client(engines(tts=slot(synth))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1, lang="fr")
        assert socket.receive_json()["code"] == "bad_request"
        say(socket, 2, text="a" * 401)
        assert socket.receive_json() == {"type": "error", "id": 2, "code": "too_long", "message": "sentence refused"}
        socket.send_text("not json")
        assert socket.receive_json()["id"] is None
    assert synth.spoken == []


def test_a_model_failure_mid_sentence_is_reported_without_an_end():
    with client(engines(tts=slot(FakeSynth(chunks=3, fail_at=1)))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        assert frame(socket.receive_bytes())[:2] == (1, 0)
        failure = socket.receive_json()
    assert (failure["type"], failure["code"], failure["message"]) == ("error", "synthesis_failed", "RuntimeError: model fell over")


def test_cancel_stops_the_sentence_and_drops_the_queue():
    slow = FakeSynth(chunks=200, delay_s=0.01)
    with client(engines(tts=slot(slow))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        say(socket, 2)
        socket.receive_bytes()
        socket.send_text(json.dumps({"type": "cancel"}))
        slow.chunks = 2
        say(socket, 3)
        seen = []
        while True:
            message = socket.receive()
            if message.get("bytes") is not None:
                seen.append(frame(message["bytes"])[0])
            elif json.loads(message["text"])["type"] == "end":
                assert json.loads(message["text"])["id"] == 3
                break
    assert 2 not in seen and seen.count(1) < 199 and seen.count(3) == 2


def test_a_refused_sentence_never_echoes_an_id_that_is_not_one():
    with client(engines(tts=slot(FakeSynth()))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        replies = []
        for bad in (True, 2**40, -1):
            say(socket, bad)
            replies.append(socket.receive_json())
    assert [(reply["id"], reply["code"]) for reply in replies] == [(None, "bad_request")] * 3


def test_the_voice_starts_loading_as_soon_as_a_session_opens():
    loaded = threading.Event()

    def load() -> FakeSynth:
        loaded.set()
        return FakeSynth()

    with client(engines(tts=ModelSlot(load, idle_unload_s=600))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        assert socket.receive_json() == {"type": "ready", "voice": "stock"}
        assert loaded.wait(RECEIVE_DEADLINE_S)


def test_an_unexpected_failure_while_loading_is_reported_and_the_session_carries_on(caplog):
    checks = []

    def check() -> None:
        checks.append(1)
        if len(checks) <= 2:
            raise RuntimeError("the load check fell over")

    with client(engines(tts=slot(FakeSynth(), guard=check))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        early = socket.receive_json()
        say(socket, 1)
        failure = socket.receive_json()
        say(socket, 2)
        frames = [frame(socket.receive_bytes())[:2] for _ in range(2)]
        end = socket.receive_json()
    unavailable = {"type": "error", "code": "unavailable", "message": "RuntimeError: the load check fell over"}
    assert early == {**unavailable, "id": None} and failure == {**unavailable, "id": 1}
    assert frames == [(2, 0), (2, 1)] and end == {"type": "end", "id": 2, "samples": 4800}
    assert "RuntimeError: the load check fell over" in caplog.text


def test_an_unexpected_failure_mid_sentence_is_reported_and_the_session_carries_on(caplog):
    synth = FakeSynth(chunks=3, garbled_at=1)
    with client(engines(tts=slot(synth))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        first = frame(socket.receive_bytes())[:2]
        failure = socket.receive_json()
        synth.garbled_at = None
        say(socket, 2)
        frames = [frame(socket.receive_bytes())[:2] for _ in range(3)]
        end = socket.receive_json()
    assert first == (1, 0)
    assert (failure["type"], failure["id"], failure["code"]) == ("error", 1, "synthesis_failed")
    assert failure["message"].startswith("ValueError: could not convert string to float")
    assert frames == [(2, 0), (2, 1), (2, 2)] and end == {"type": "end", "id": 2, "samples": 7200}
    assert "could not convert string to float" in caplog.text


@pytest.mark.parametrize("fail_at", [None, 1], ids=["audio", "failure"])
def test_nothing_of_a_cancelled_sentence_follows_the_cancel(fail_at):
    gate = threading.Event()
    synth = FakeSynth(chunks=3, fail_at=fail_at, gate=gate)
    with client(engines(tts=slot(synth))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        assert frame(socket.receive_bytes())[:2] == (1, 0)
        cancel_and_wait(socket)
        gate.set()
        say(socket, 2)
        after = until_done(socket, 2)
    assert [kind for sentence_id, kind in after if sentence_id == 1] == []
    assert after[-1] == (2, "end" if fail_at is None else "error")


def test_a_cancelled_sentence_whose_load_fails_reports_nothing():
    gate = threading.Event()
    attempts = []

    def load() -> FakeSynth:
        attempts.append(1)
        if len(attempts) == 3:
            return FakeSynth()
        if len(attempts) == 2:
            gate.wait(RECEIVE_DEADLINE_S)
        raise OSError("not in the cache")

    with client(engines(tts=ModelSlot(load, idle_unload_s=600))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        assert socket.receive_json()["id"] is None
        say(socket, 1)
        cancel_and_wait(socket)
        gate.set()
        say(socket, 2)
        after = until_done(socket, 2)
    assert after == [(2, "audio"), (2, "audio"), (2, "end")]


def test_sessions_take_turns_with_the_model():
    synth = FakeSynth(chunks=4, delay_s=0.01)
    with client(engines(tts=slot(synth))) as shared:
        with (
            shared.websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as first,
            shared.websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as second,
        ):
            first.receive_json()
            second.receive_json()
            say(first, 1, "First.")
            say(second, 2, "Second.")
            assert until_done(first, 1) == [(1, "audio")] * 4 + [(1, "end")]
            assert until_done(second, 2) == [(2, "audio")] * 4 + [(2, "end")]
    assert synth.decoded in (["First."] * 4 + ["Second."] * 4, ["Second."] * 4 + ["First."] * 4)


def test_every_model_call_runs_on_the_model_thread():
    gate = threading.Event()
    synth = FakeSynth(chunks=3, gate=gate)
    with client(engines(tts=ThreadNotingSlot(synth, synth.threads))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        say(socket, 1)
        socket.receive_bytes()
        cancel_and_wait(socket)
        gate.set()
        say(socket, 2)
        until_done(socket, 2)
    assert {name.rsplit("_", 1)[0] for name in synth.threads} == {"voiced-model"}


def test_a_model_that_fails_to_load_makes_the_sentence_unavailable():
    def load() -> FakeSynth:
        raise OSError("not in the Hugging Face cache")

    with client(engines(tts=ModelSlot(load, idle_unload_s=600))).websocket_connect(f"{WS_URL}/tts", subprotocols=WS_PROTOCOLS) as socket:
        socket.receive_json()
        early = socket.receive_json()
        say(socket, 1)
        failure = socket.receive_json()
    unavailable = {"type": "error", "code": "unavailable", "message": "OSError: not in the Hugging Face cache"}
    assert early == {**unavailable, "id": None} and failure == {**unavailable, "id": 1}
