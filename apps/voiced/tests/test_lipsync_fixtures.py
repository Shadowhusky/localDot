import json
from pathlib import Path

import pytest

from voiced.lipsync import score

FIXTURES = sorted((Path(__file__).parent / "fixtures" / "lipsync").glob("*.json"))


def test_six_sentences_are_recorded():
    assert [p.stem for p in FIXTURES] == ["en-1", "en-2", "ja-1", "ja-2", "zh-1", "zh-2"]


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_recorded_mouth_shapes_open_on_voice_and_rest_on_silence(path):
    fixture = json.loads(path.read_text(encoding="utf-8"))
    visemes = fixture["visemes"]
    times = [v["t"] for v in visemes]
    assert times == sorted(times) and visemes[-1]["shape"] == "rest"
    assert times[-1] <= fixture["samples"] * 1000 / fixture["sample_rate"] + 300
    result = score(visemes, fixture["rms"])
    assert result["onsets_on_voiced"] >= 0.9, result
    assert result["rest_on_silence"] >= 0.9, result


def test_scores_a_mouth_that_moves_in_silence_as_wrong():
    rms = [0.0] * 50 + [0.2] * 50
    early = [{"t": 0, "shape": "A"}, {"t": 500, "shape": "rest"}]
    assert score(early, rms) == {"onsets_on_voiced": 0.0, "rest_on_silence": 0.0}
    right = [{"t": 500, "shape": "A"}, {"t": 990, "shape": "rest"}]
    assert score(right, rms)["onsets_on_voiced"] == 1.0


def test_an_onset_up_to_100_ms_ahead_of_the_voice_counts_as_on_it():
    rms = [0.0] * 50 + [0.2] * 50
    assert score([{"t": 410, "shape": "A"}, {"t": 990, "shape": "rest"}], rms)["onsets_on_voiced"] == 1.0
    assert score([{"t": 390, "shape": "A"}, {"t": 990, "shape": "rest"}], rms)["onsets_on_voiced"] == 0.0
