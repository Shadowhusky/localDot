"""voiced's settings, read once from the environment the host passes it."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PORT = 4752
MIN_TOKEN_LENGTH = 32
IDLE_UNLOAD_S = 600.0
LM_STUDIO_URL = "http://127.0.0.1:1234"


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class VoiceRef:
    audio: Path
    text: str


@dataclass(frozen=True)
class Settings:
    token: str
    port: int = DEFAULT_PORT
    voice: VoiceRef | None = None
    lm_studio_url: str = LM_STUDIO_URL
    idle_unload_s: float = IDLE_UNLOAD_S
    accurate_asr: bool = False
    parent_pid: int | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        token = env.get("LOCALDOT_VOICED_TOKEN", "")
        if len(token) < MIN_TOKEN_LENGTH:
            raise ConfigError(f"LOCALDOT_VOICED_TOKEN must be at least {MIN_TOKEN_LENGTH} characters")
        return cls(
            token=token,
            port=_int(env, "LOCALDOT_VOICED_PORT", DEFAULT_PORT),
            voice=_voice(env.get("LOCALDOT_VOICE_DIR")),
            lm_studio_url=env.get("LOCALDOT_LMSTUDIO_URL", LM_STUDIO_URL).rstrip("/"),
            idle_unload_s=float(_int(env, "LOCALDOT_VOICED_IDLE_S", int(IDLE_UNLOAD_S))),
            accurate_asr=env.get("LOCALDOT_ASR") == "accurate",
            parent_pid=_int(env, "LOCALDOT_VOICED_PARENT_PID", 0) or None,
        )


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ConfigError(f"{key} must be a whole number") from error


def _voice(directory: str | None) -> VoiceRef | None:
    """A voice folder holds the reference clip and its transcript: ref.wav and ref.txt."""
    if not directory:
        return None
    root = Path(directory)
    audio, transcript = root / "ref.wav", root / "ref.txt"
    for required in (audio, transcript):
        if not required.is_file():
            raise ConfigError(f"voice folder is missing {required.name}")
    text = transcript.read_text(encoding="utf-8").strip()
    if not text:
        raise ConfigError("ref.txt is empty")
    return VoiceRef(audio=audio, text=text)
