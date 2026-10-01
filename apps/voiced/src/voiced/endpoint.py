"""Hands-free end of speech from per-frame voice probabilities, in audio time."""

from dataclasses import dataclass
from typing import Literal

SILENCE_MS = 500
MERGE_MS = 1000
PARTIAL_EVERY_MS = 500
THRESHOLD = 0.5

EventKind = Literal["speech_started", "turn_ended", "utterance_ended", "partial_due"]


@dataclass(frozen=True)
class EndpointEvent:
    kind: EventKind
    utterance: int
    at_ms: float


class Endpointer:
    """A turn ends after SILENCE_MS of silence; speech that resumes before the pause reaches
    MERGE_MS joins the same utterance, which ends once the pause does."""

    def __init__(self, silence_ms: float = SILENCE_MS, merge_ms: float = MERGE_MS) -> None:
        self._silence_ms = silence_ms
        self._merge_ms = merge_ms
        self._clock_ms = 0.0
        self._utterance = 0
        self._speaking = False
        self._open = False
        self._turn_ended = False
        self._silence_since: float | None = None
        self._next_partial_ms = 0.0

    def push(self, probability: float, frame_ms: float) -> list[EndpointEvent]:
        start = self._clock_ms
        self._clock_ms += frame_ms
        events: list[EndpointEvent] = []
        if probability >= THRESHOLD:
            if not self._open:
                self._utterance += 1
                self._open = True
                self._next_partial_ms = start + PARTIAL_EVERY_MS
            if not self._speaking:
                events.append(EndpointEvent("speech_started", self._utterance, start))
            self._speaking = True
            self._turn_ended = False
            self._silence_since = None
        elif self._open:
            if self._silence_since is None:
                self._silence_since = start
            paused = self._clock_ms - self._silence_since
            if not self._turn_ended and paused >= self._silence_ms:
                self._speaking = False
                self._turn_ended = True
                events.append(EndpointEvent("turn_ended", self._utterance, self._clock_ms))
            if paused >= self._merge_ms:
                self._open = False
                self._turn_ended = False
                self._silence_since = None
                events.append(EndpointEvent("utterance_ended", self._utterance, self._clock_ms))
        if self._silence_since is None and self._open and self._clock_ms >= self._next_partial_ms:
            self._next_partial_ms = self._clock_ms + PARTIAL_EVERY_MS
            events.append(EndpointEvent("partial_due", self._utterance, self._clock_ms))
        return events
