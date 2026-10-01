"""Real models from the local Hugging Face cache. GPU-heavy: tell the core session first.

Run: HF_HUB_OFFLINE=1 uv run pytest -m models -q
"""

import os
import re
import time
import unicodedata
from pathlib import Path

import numpy as np
import pytest

from voiced.config import VoiceRef
from voiced.lipsync import SENTENCES

pytestmark = pytest.mark.models

FIRST_AUDIO_BUDGET_S = 0.7
LINES = [("zh", "你终于回来了。"), ("en", "Hey, you're finally back."), ("ja", "やっと帰ってきたのね。")]
# Long enough (16+ open shapes each) that one onset missed on the aligner's 80 ms grid cannot sink a score.
ALIGNED_LINES = [SENTENCES["zh-1"], SENTENCES["en-1"], SENTENCES["ja-1"]]


def first_audio(synth, text: str, lang: str) -> tuple[float, np.ndarray]:
    started = time.perf_counter()
    stream = synth.stream(text, lang)
    first = next(stream)
    elapsed = time.perf_counter() - started
    return elapsed, np.concatenate([first, *stream])


@pytest.fixture(scope="module")
def stock():
    from voiced.synth import load_synthesizer

    synth = load_synthesizer(None)
    list(synth.stream("你好。", "zh"))
    return synth


@pytest.mark.parametrize(("lang", "text"), LINES)
def test_the_stock_voice_starts_each_language_within_budget(stock, lang, text):
    elapsed, audio = first_audio(stock, text, lang)
    assert stock.sample_rate == 24_000
    assert elapsed < FIRST_AUDIO_BUDGET_S
    assert audio.size > 0.5 * stock.sample_rate and float(np.abs(audio).max()) > 0.05


def test_the_pack_voice_starts_within_budget():
    directory = os.environ.get("LOCALDOT_VOICE_DIR")
    if not directory:
        pytest.skip("set LOCALDOT_VOICE_DIR to a voice folder to check a pack voice")
    from voiced.synth import load_synthesizer

    root = Path(directory)
    synth = load_synthesizer(VoiceRef(root / "ref.wav", (root / "ref.txt").read_text(encoding="utf-8").strip()))
    list(synth.stream("Hi.", "en"))
    for lang, text in LINES:
        elapsed, audio = first_audio(synth, text, lang)
        assert elapsed < FIRST_AUDIO_BUDGET_S and audio.size > 0


@pytest.fixture(scope="module")
def aligner(stock):
    from voiced.align import load_aligner, warm_up

    loaded = load_aligner()
    warm_up(loaded, stock.sample_rate)
    return loaded


@pytest.mark.parametrize(("lang", "text"), ALIGNED_LINES)
def test_aligned_shapes_open_on_the_voice_and_arrive_quickly(stock, aligner, lang, text):
    from voiced.lipsync import rms_per_hop, score
    from voiced.visemes import build_track

    _, audio = first_audio(stock, text, lang)
    started = time.perf_counter()
    units = aligner.align(audio, stock.sample_rate, text, lang)
    assert time.perf_counter() - started < 0.3
    starts = [u.start for u in units]
    assert units and starts == sorted(starts)
    assert units[-1].end <= audio.size / stock.sample_rate + 0.1
    result = score(build_track(units, lang), rms_per_hop(audio, stock.sample_rate))
    assert result["onsets_on_voiced"] >= 0.85, result


def to_16k(audio: np.ndarray, rate: int) -> np.ndarray:
    from mlx_audio.resample import resample_audio_array

    return resample_audio_array(np.asarray(audio, dtype=np.float32), rate, 16_000)


def normalise(text: str) -> str:
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", text).lower())


def error_rate(expected: str, heard: str) -> float:
    a, b = normalise(expected), normalise(heard)
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        previous, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (ca != cb))
    return row[len(b)] / max(len(a), 1)


@pytest.fixture(scope="module")
def recognizer():
    from voiced.listen import load_recognizer

    loaded = load_recognizer(accurate=False)
    loaded.transcribe(np.zeros(16_000, dtype=np.float32))
    return loaded


@pytest.mark.parametrize(("lang", "text"), LINES[:2])
def test_push_to_talk_decodes_a_spoken_line_within_budget(stock, recognizer, lang, text):
    _, audio = first_audio(stock, text, lang)
    clip = to_16k(audio, stock.sample_rate)
    started = time.perf_counter()
    heard, heard_lang = recognizer.transcribe(clip)
    assert time.perf_counter() - started < 0.4
    assert heard_lang == lang
    assert error_rate(text, heard) <= 0.1, heard


def test_silero_hears_speech_and_not_silence(stock):
    from voiced.listen import load_vad

    new_probe = load_vad()
    _, audio = first_audio(stock, "Hey, you're finally back.", "en")
    clip = to_16k(audio, stock.sample_rate)
    speaking = new_probe()
    speech = [speaking.probability(clip[i : i + 512]) for i in range(0, clip.size - 512, 512)]
    quiet = new_probe()
    silence = [quiet.probability(np.zeros(512, dtype=np.float32)) for _ in range(30)]
    assert max(speech) > 0.5 and max(silence) < 0.5
