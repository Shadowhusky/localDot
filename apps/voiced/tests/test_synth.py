from pathlib import Path
from types import SimpleNamespace

import numpy as np

from voiced.config import VoiceRef
from voiced.synth import MlxSynthesizer


class FakeModel:
    sample_rate = 24_000

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def generate(self, **options):
        self.calls.append(options)
        yield SimpleNamespace(audio=np.zeros(4, dtype=np.float32))


def test_each_sentence_may_only_run_as_long_as_its_text_allows():
    model = FakeModel()
    list(MlxSynthesizer(model, None).stream("Hi.", "en"))
    list(MlxSynthesizer(model, VoiceRef(Path("/voice/ref.wav"), "Hello.")).stream("你" * 400, "zh"))
    stream = {"stream": True, "streaming_interval": 0.32}
    assert model.calls == [
        {"text": "Hi.", "lang_code": "English", **stream, "max_tokens": 75, "voice": "Vivian"},
        {"text": "你" * 400, "lang_code": "Chinese", **stream, "max_tokens": 3000, "ref_audio": "/voice/ref.wav", "ref_text": "Hello."},
    ]
