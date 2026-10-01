import json
import struct

import numpy as np

from conftest import WS_PROTOCOLS, WS_URL, FakeSynth, client, engines, slot


def frame(data: bytes) -> tuple[int, int, list[int]]:
    sentence_id, seq = struct.unpack("<II", data[:8])
    return sentence_id, seq, np.frombuffer(data[8:], dtype="<i2").tolist()


def say(socket, sentence_id, text="Hello there.", lang="en"):
    socket.send_text(json.dumps({"type": "say", "id": sentence_id, "text": text, "lang": lang}))


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
        say(socket, 1)
        reply = socket.receive_json()
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
