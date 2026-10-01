"""Qwen3-TTS on MLX: a pack voice cloned from its reference clip, or the stock speaker."""

from collections.abc import Iterator
from typing import Any

import numpy as np

from voiced.config import VoiceRef

TTS_PACK = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
TTS_STOCK = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
STOCK_SPEAKER = "Vivian"
LANG_NAMES = {"zh": "Chinese", "en": "English", "ja": "Japanese"}
STREAM_INTERVAL_S = 0.32
CODEC_HZ = 12.5
# About twice the slowest speech measured (0.26 s a Han character), never under 6 s: without a cap a
# missed end token streams on to mlx-audio's 4096 codec frames, five and a half minutes.
MAX_SECONDS_PER_CHAR = 0.6
MIN_SECONDS = 6.0


def max_tokens(text: str) -> int:
    return round(CODEC_HZ * max(MIN_SECONDS, MAX_SECONDS_PER_CHAR * len(text)))


class MlxSynthesizer:
    def __init__(self, model: Any, voice: VoiceRef | None) -> None:
        self.model = model
        self.voice = voice
        self.sample_rate = int(model.sample_rate)

    def stream(self, text: str, lang: str) -> Iterator[np.ndarray]:
        options: dict[str, Any] = {
            "text": text,
            "lang_code": LANG_NAMES[lang],
            "stream": True,
            "streaming_interval": STREAM_INTERVAL_S,
            "max_tokens": max_tokens(text),
        }
        if self.voice:
            options.update(ref_audio=str(self.voice.audio), ref_text=self.voice.text)
        else:
            options.update(voice=STOCK_SPEAKER)
        for result in self.model.generate(**options):
            yield np.asarray(result.audio, dtype=np.float32)


def load_synthesizer(voice: VoiceRef | None) -> MlxSynthesizer:
    from mlx_audio.tts.utils import load_model

    return MlxSynthesizer(load_model(TTS_PACK if voice else TTS_STOCK), voice)
