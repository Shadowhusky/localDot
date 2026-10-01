"""Qwen3-ForcedAligner on MLX: when each word or character of a sentence was spoken."""

from typing import Any

import numpy as np

from voiced.synth import LANG_NAMES
from voiced.visemes import Unit, build_track

ALIGNER = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
ALIGN_SAMPLE_RATE = 16_000
# Aligning a word per language loads what each language's first track would otherwise wait for: the
# aligner's Japanese word splitter, then pypinyin, pyopenjtalk and CMUdict as the track is shaped.
WARM_UP = {"zh": "你好", "ja": "こんにちは", "en": "hello"}


class MlxAligner:
    def __init__(self, model: Any) -> None:
        self.model = model

    def align(self, audio: np.ndarray, sample_rate: int, text: str, lang: str) -> list[Unit]:
        from mlx_audio.resample import resample_audio_array

        # Given samples rather than a file, the aligner assumes 16 kHz; speech comes out at 24 kHz.
        audio16 = resample_audio_array(np.asarray(audio, dtype=np.float32), sample_rate, ALIGN_SAMPLE_RATE)
        result = self.model.generate(audio16, text=text, language=LANG_NAMES[lang])
        return [Unit(item.text, float(item.start_time), float(item.end_time)) for item in result]


def load_aligner() -> MlxAligner:
    from mlx_audio.stt import load

    return MlxAligner(load(ALIGNER))


def warm_up(aligner: MlxAligner, sample_rate: int) -> None:
    silence = np.zeros(sample_rate // 2, dtype=np.float32)
    for lang, text in WARM_UP.items():
        build_track(aligner.align(silence, sample_rate, text, lang), lang)
