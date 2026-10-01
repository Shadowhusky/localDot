import pytest

from voiced import engines
from voiced.config import Settings
from voiced.engines import Engines
from voiced.slots import LoadFailed, LoadRefused, ModelSlot


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_loads_once_on_first_use_and_unloads_after_ten_idle_minutes():
    loads, released = [], []
    clock = Clock()
    slot = ModelSlot(lambda: loads.append(1) or "model", 600, clock=clock, release=lambda: released.append(1))
    assert slot.state == "idle"
    assert slot.get() == "model" and slot.get() == "model"
    assert (loads, slot.state) == ([1], "ready")
    clock.now = 599
    assert slot.sweep() is False
    clock.now = 600
    assert slot.sweep() is True
    assert (slot.state, released) == ("idle", [1])
    slot.get()
    assert loads == [1, 1]


def test_use_restarts_the_idle_clock():
    clock = Clock()
    slot = ModelSlot(lambda: "model", 600, clock=clock, release=lambda: None)
    slot.get()
    clock.now = 500
    slot.get()
    clock.now = 1000
    assert slot.sweep() is False


def test_a_guard_refuses_the_load_and_says_why():
    slot = ModelSlot(lambda: "model", 600, guard=lambda: "LM Studio has big loaded (44.5 GB)")
    with pytest.raises(LoadRefused, match="44.5 GB"):
        slot.get()
    assert (slot.state, slot.reason) == ("refused", "LM Studio has big loaded (44.5 GB)")


def test_a_failed_load_is_reported_and_retried_next_time():
    attempts = []

    def loader():
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("not in the cache")
        return "model"

    slot = ModelSlot(loader, 600)
    with pytest.raises(LoadFailed, match="not in the cache"):
        slot.get()
    assert slot.state == "failed"
    assert slot.get() == "model"
    assert slot.state == "ready"


def test_large_models_refuse_while_lm_studio_holds_a_huge_one(monkeypatch):
    monkeypatch.setattr(engines, "lm_studio_refusal", lambda url: f"LM Studio at {url} has big loaded (44.5 GB)")
    settings = Settings(token="t" * 43)
    with pytest.raises(LoadRefused, match="127.0.0.1:1234 has big loaded"):
        engines.model_slot(settings, lambda: "model").get()
    assert engines.model_slot(settings, lambda: "vad", guarded=False).get() == "vad"


def test_engines_report_each_slot_and_sweep_the_idle_ones():
    clock = Clock()
    idle = ModelSlot(lambda: "a", 600, clock=clock, release=lambda: None)
    busy = ModelSlot(lambda: "b", 600, clock=clock, release=lambda: None)
    both = Engines(voice="pack", slots={"tts": idle, "asr": busy})
    idle.get()
    clock.now = 700
    busy.get()
    assert both.sweep() == ["tts"]
    assert both.status() == {"tts": {"state": "idle", "reason": None}, "asr": {"state": "ready", "reason": None}}
