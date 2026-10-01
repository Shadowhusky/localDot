"""A model loaded on first use and dropped after it sits idle, with an optional load guard."""

import gc
import time
from collections.abc import Callable
from typing import Generic, Literal, TypeVar

T = TypeVar("T")
SlotState = Literal["idle", "loading", "ready", "failed", "refused"]


class LoadRefused(RuntimeError):
    pass


class LoadFailed(RuntimeError):
    pass


class ModelSlot(Generic[T]):
    """Every method runs on the model worker thread, so loads and sweeps never overlap."""

    def __init__(
        self,
        loader: Callable[[], T],
        idle_unload_s: float,
        guard: Callable[[], str | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        release: Callable[[], None] = gc.collect,
    ) -> None:
        self._loader = loader
        self._idle_unload_s = idle_unload_s
        self._guard = guard
        self._clock = clock
        self._release = release
        self._value: T | None = None
        self._last_used = 0.0
        self.state: SlotState = "idle"
        self.reason: str | None = None

    def get(self) -> T:
        if self._value is None:
            refused = self._guard() if self._guard else None
            if refused:
                self.state, self.reason = "refused", refused
                raise LoadRefused(refused)
            self.state, self.reason = "loading", None
            try:
                self._value = self._loader()
            except Exception as error:
                self.state, self.reason = "failed", f"{type(error).__name__}: {error}"
                raise LoadFailed(self.reason) from error
            self.state = "ready"
        self._last_used = self._clock()
        return self._value

    def sweep(self) -> bool:
        if self._value is None or self._clock() - self._last_used < self._idle_unload_s:
            return False
        self._value = None
        self.state = "idle"
        self._release()
        return True
