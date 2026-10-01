"""The models voiced serves, each in a slot that loads on first use."""

import gc
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from voiced.config import Settings
from voiced.lmstudio import lm_studio_refusal
from voiced.slots import ModelSlot
from voiced.synth import load_synthesizer

log = logging.getLogger(__name__)


@dataclass
class Engines:
    voice: str
    slots: dict[str, ModelSlot[Any]]

    def status(self) -> dict[str, dict[str, str | None]]:
        return {name: {"state": slot.state, "reason": slot.reason} for name, slot in self.slots.items()}

    def sweep(self) -> list[str]:
        swept = []
        for name, slot in self.slots.items():
            try:
                if slot.sweep():
                    swept.append(name)
            except Exception:
                log.exception("unloading the %s model failed", name)
        return swept


def release_memory() -> None:
    import mlx.core as mx

    gc.collect()
    mx.clear_cache()


def model_slot(settings: Settings, loader: Callable[[], Any], guarded: bool = True) -> ModelSlot[Any]:
    """A slot for an MLX model; a guarded one refuses to load beside a huge LM Studio model."""
    guard = (lambda: lm_studio_refusal(settings.lm_studio_url)) if guarded else None
    return ModelSlot(loader, settings.idle_unload_s, guard, release=release_memory)


def mlx_engines(settings: Settings) -> Engines:
    return Engines(
        voice="pack" if settings.voice else "stock",
        slots={"tts": model_slot(settings, lambda: load_synthesizer(settings.voice))},
    )
