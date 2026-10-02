"""Hands-free end of speech from per-frame voice probabilities, in audio time."""

from dataclasses import dataclass
from typing import Literal

SILENCE_MS = 500
MERGE_MS = 1000
# A pause this long usually ends the turn, so the turn is decoded now and its final needs no decode later.
PAUSING_MS = 250
PARTIAL_EVERY_MS = 500
THRESHOLD = 0.5
# Speech is this many frames in a row, about 96 ms: a cough or a click is not someone talking to her.
MIN_SPEECH_FRAMES = 3

EventKind = Literal["speech_started", "turn_pausing", "turn_ended", "utterance_ended", "partial_due"]


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
        self._run = 0
        self._pausing = False

    @property
    def pausing(self) -> bool:
        """The turn has paused for PAUSING_MS and no speech has come since."""
        return self._pausing

    def push(self, probability: float, frame_ms: float) -> list[EndpointEvent]:
        start = self._clock_ms
        self._clock_ms += frame_ms
        events: list[EndpointEvent] = []
        self._run = self._run + 1 if probability >= THRESHOLD else 0
        mid_speech = self._speaking and self._silence_since is None
        if self._run >= MIN_SPEECH_FRAMES or (self._run and mid_speech):
            if not self._open:
                self._utterance += 1
                self._open = True
            if not self._speaking:
                events.append(EndpointEvent("speech_started", self._utterance, start))
                self._next_partial_ms = start + PARTIAL_EVERY_MS
            self._speaking = True
            self._turn_ended = False
            self._pausing = False
            self._silence_since = None
        elif self._open and not self._run:
            # A blip too short to be speech counts as part of the pause; frames that may yet become speech
            # hold the pause where it is, so speech resuming just before a limit still keeps the turn.
            if self._silence_since is None:
                self._silence_since = start
            paused = self._clock_ms - self._silence_since
            if not self._pausing and not self._turn_ended and paused >= PAUSING_MS:
                self._pausing = True
                events.append(EndpointEvent("turn_pausing", self._utterance, self._clock_ms))
            if not self._turn_ended and paused >= self._silence_ms:
                self._speaking = False
                self._turn_ended = True
                events.append(EndpointEvent("turn_ended", self._utterance, self._clock_ms))
            if paused >= self._merge_ms:
                self._open = False
                self._turn_ended = False
                self._pausing = False
                self._silence_since = None
                events.append(EndpointEvent("utterance_ended", self._utterance, self._clock_ms))
        if self._silence_since is None and self._open and self._clock_ms >= self._next_partial_ms:
            self._next_partial_ms = self._clock_ms + PARTIAL_EVERY_MS
            events.append(EndpointEvent("partial_due", self._utterance, self._clock_ms))
        return events
