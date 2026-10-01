import numpy as np

from voiced.wire import Say, encode_audio_frame, parse_say, to_int16


def test_frames_match_the_browser_decoder_byte_for_byte():
    pcm = np.array([0, 1, -1, 32767, -32768], dtype="<i2")
    assert encode_audio_frame(7, 2, pcm).hex() == "070000000200000000000100ffffff7f0080"
    assert to_int16(np.array([0.5, -0.5, 1.5, -1.5])).tolist() == [16384, -16384, 32767, -32768]


def test_parse_say_accepts_a_sentence_and_names_what_is_wrong():
    assert parse_say({"id": 3, "text": " Hello\nthere. ", "lang": "en"}) == Say(3, "Hello there.", "en")
    assert parse_say({"id": 3, "text": "Hi.", "lang": "fr"}) == "bad_request"
    assert parse_say({"id": True, "text": "Hi.", "lang": "en"}) == "bad_request"
    assert parse_say({"id": 3, "text": "   ", "lang": "en"}) == "bad_request"
    assert parse_say({"id": 3, "text": "a" * 401, "lang": "en"}) == "too_long"
    assert parse_say(["say"]) == "bad_request"
