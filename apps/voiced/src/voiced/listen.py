"""Qwen3-ASR and Silero VAD on MLX: what was said, and whether anyone is speaking."""

from typing import Any

import numpy as np

ASR_FAST = "mlx-community/Qwen3-ASR-0.6B-8bit"
ASR_ACCURATE = "mlx-community/Qwen3-ASR-1.7B-8bit"
VAD = "mlx-community/silero-vad"
ASR_LANGS = {"chinese": "zh", "cantonese": "zh", "english": "en", "japanese": "ja"}


class MlxRecognizer:
    def __init__(self, model: Any) -> None:
        self.model = model

    def transcribe(self, audio: np.ndarray) -> tuple[str, str | None]:
        result = self.model.generate(np.asarray(audio, dtype=np.float32))
        language = result.language[0] if isinstance(result.language, list) and result.language else result.language
        return str(result.text).strip(), ASR_LANGS.get(str(language or "").lower())


def load_recognizer(accurate: bool) -> MlxRecognizer:
    from mlx_audio.stt import load

    return MlxRecognizer(load(ASR_ACCURATE if accurate else ASR_FAST))


class SileroProbe:
    """Silero's streaming state for one listening session; the model itself is shared."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.state = model.initial_state(sample_rate=16_000)

    def probability(self, frame: np.ndarray) -> float:
        import mlx.core as mx

        probability, self.state = self.model.feed(frame, self.state, sample_rate=16_000)
        mx.eval(probability)
        return float(np.asarray(probability).reshape(-1)[0])


def load_vad() -> Any:
    from mlx_audio.vad.utils import load

    model = load(VAD)
    return lambda: SileroProbe(model)
