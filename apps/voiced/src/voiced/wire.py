"""What /tts and /stt send and accept; the browser package decodes the same bytes."""

import struct
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 24_000
MIC_SAMPLE_RATE = 16_000
MAX_SENTENCE_CHARS = 400
LANGS = ("zh", "en", "ja")


def to_int16(audio: np.ndarray) -> np.ndarray:
    clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    scaled = np.where(clipped < 0, clipped * 32768.0, clipped * 32767.0)
    return np.round(scaled).astype("<i2")


def encode_audio_frame(sentence_id: int, seq: int, pcm: np.ndarray) -> bytes:
    """u32 sentence id, u32 chunk index, then little-endian int16 mono PCM at 24 kHz."""
    return struct.pack("<II", sentence_id, seq) + np.asarray(pcm, dtype="<i2").tobytes()


@dataclass(frozen=True)
class Say:
    id: int
    text: str
    lang: str


def parse_say(message: object) -> Say | str:
    """A valid sentence, or the reason it is not one."""
    if not isinstance(message, dict):
        return "bad_request"
    sentence_id, text, lang = message.get("id"), message.get("text"), message.get("lang")
    if not isinstance(sentence_id, int) or isinstance(sentence_id, bool) or not 0 <= sentence_id <= 0xFFFFFFFF:
        return "bad_request"
    if not isinstance(text, str) or not text.strip() or lang not in LANGS:
        return "bad_request"
    if len(text) > MAX_SENTENCE_CHARS:
        return "too_long"
    return Say(sentence_id, " ".join(text.split()), lang)


def error(sentence_id: int | None, code: str, message: str) -> dict:
    return {"type": "error", "id": sentence_id, "code": code, "message": message}
