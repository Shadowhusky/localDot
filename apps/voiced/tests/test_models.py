"""Real models from the local Hugging Face cache. GPU-heavy: tell the core session first.

Run: HF_HUB_OFFLINE=1 uv run pytest -m models -q
"""

import os
import time
from pathlib import Path

import numpy as np
import pytest

from voiced.config import VoiceRef

pytestmark = pytest.mark.models

FIRST_AUDIO_BUDGET_S = 0.7
LINES = [("zh", "你终于回来了。"), ("en", "Hey, you're finally back."), ("ja", "やっと帰ってきたのね。")]


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
