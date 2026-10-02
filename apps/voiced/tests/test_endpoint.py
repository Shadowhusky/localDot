from voiced.endpoint import Endpointer

FRAME_MS = 32


def run(pattern):
    """pattern: list of (probability, milliseconds); returns events as (kind, utterance, at_ms)."""
    ep = Endpointer()
    events = []
    for probability, ms in pattern:
        for _ in range(round(ms / FRAME_MS)):
            events += [(e.kind, e.utterance, e.at_ms) for e in ep.push(probability, FRAME_MS)]
    return [e for e in events if e[0] != "partial_due"]


def test_a_turn_ends_after_500_ms_of_silence_and_the_utterance_after_1_s():
    events = run([(0.0, 320), (0.9, 640), (0.0, 1280)])
    assert events == [
        ("speech_started", 1, 384),
        ("turn_ended", 1, 1472),
        ("utterance_ended", 1, 1984),
    ]


def test_a_pause_shorter_than_1_s_joins_the_same_utterance():
    events = run([(0.9, 640), (0.0, 704), (0.9, 320), (0.0, 1280)])
    assert events == [
        ("speech_started", 1, 64),
        ("turn_ended", 1, 1152),
        ("speech_started", 1, 1408),
        ("turn_ended", 1, 2176),
        ("utterance_ended", 1, 2688),
    ]


def test_a_pause_of_1_s_or_more_starts_a_new_utterance():
    events = run([(0.9, 320), (0.0, 1024), (0.9, 320), (0.0, 1024)])
    assert [e[:2] for e in events] == [
        ("speech_started", 1),
        ("turn_ended", 1),
        ("utterance_ended", 1),
        ("speech_started", 2),
        ("turn_ended", 2),
        ("utterance_ended", 2),
    ]


def test_short_dips_inside_speech_do_not_end_the_turn():
    events = run([(0.9, 320), (0.0, 448), (0.9, 320), (0.0, 1024)])
    assert [e[0] for e in events] == ["speech_started", "turn_ended", "utterance_ended"]


def test_partials_are_due_every_500_ms_of_speech_only():
    ep = Endpointer()
    due = []
    for i in range(round(2000 / FRAME_MS)):
        probability = 0.9 if i * FRAME_MS < 1200 else 0.0
        due += [e.at_ms for e in ep.push(probability, FRAME_MS) if e.kind == "partial_due"]
    assert due == [576, 1088]


def test_silence_alone_never_opens_an_utterance():
    assert run([(0.2, 5000)]) == []


def test_a_blip_of_one_or_two_frames_is_not_speech():
    assert run([(0.9, 32), (0.0, 320), (0.9, 64), (0.0, 1280)]) == []


def test_three_frames_of_speech_start_an_utterance():
    assert run([(0.0, 320), (0.9, 96), (0.0, 1280)]) == [
        ("speech_started", 1, 384),
        ("turn_ended", 1, 928),
        ("utterance_ended", 1, 1440),
    ]


def test_a_blip_inside_a_pause_neither_resumes_the_turn_nor_delays_its_end():
    assert run([(0.9, 320), (0.0, 192), (0.9, 64), (0.0, 1280)]) == [
        ("speech_started", 1, 64),
        ("turn_ended", 1, 832),
        ("utterance_ended", 1, 1344),
    ]


def test_speech_resuming_just_before_the_pause_limit_keeps_the_turn():
    events = run([(0.9, 320), (0.0, 480), (0.9, 320), (0.0, 1280)])
    assert [e[0] for e in events] == ["speech_started", "turn_ended", "utterance_ended"]


def test_a_resumed_turn_waits_500_ms_for_its_first_partial():
    ep = Endpointer()
    due = []
    for probability, ms in [(0.9, 640), (0.0, 640), (0.9, 640)]:
        for _ in range(round(ms / FRAME_MS)):
            due += [e.at_ms for e in ep.push(probability, FRAME_MS) if e.kind == "partial_due"]
    assert due == [576, 1856]
