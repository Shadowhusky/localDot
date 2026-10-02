"""One /stt connection: microphone PCM in, speech start, partial, final and end-of-utterance out."""

import asyncio
import json
import logging
import re
from collections import deque
from typing import Any

import numpy as np
from starlette.types import Message
from starlette.websockets import WebSocket, WebSocketDisconnect

from voiced.endpoint import MIN_SPEECH_FRAMES, Endpointer
from voiced.engines import Engines
from voiced.slots import LoadFailed, LoadRefused
from voiced.tts import describe
from voiced.wire import MIC_SAMPLE_RATE
from voiced.worker import Worker

FRAME = 512
FRAME_MS = 1000 * FRAME / MIC_SAMPLE_RATE
PREROLL_FRAMES = 10
MAX_FRAMES = {"handsfree": round(60_000 / FRAME_MS), "ptt": round(120_000 / FRAME_MS)}
# About a second of audio per model-thread turn, so a backlog never holds speech output up for long.
BATCH_FRAMES = 32
CJK = re.compile(r"[\U00003000-\U000030ff\U00003400-\U00004dbf\U00004e00-\U00009fff\U0000f900-\U0000faff\U0000ff00-\U0000ffef]")

log = logging.getLogger(__name__)


def join_texts(parts: list[str]) -> str:
    """Turns of one utterance joined: no space between CJK text, one space otherwise."""
    joined = ""
    for part in (p.strip() for p in parts):
        if not part:
            continue
        if joined and not (CJK.match(joined[-1]) and CJK.match(part[0])):
            joined += " "
        joined += part
    return joined


def hear(probe: Any, frames: np.ndarray) -> list[float]:
    return [probe.probability(frame.astype(np.float32) / 32768.0) for frame in frames]


class SttSession:
    def __init__(self, socket: WebSocket, engines: Engines, worker: Worker) -> None:
        self._socket = socket
        self._engines = engines
        self._worker = worker
        self._inbox: deque[Message] = deque()
        self._arrived = asyncio.Event()
        self._utterances = 0
        self._probe: Any = None
        self._stop()

    def _stop(self) -> None:
        self._mode: str | None = None
        self._carry = np.zeros(0, dtype=np.int16)
        self._reset()

    def _reset(self) -> None:
        """Forgets the open utterance; the audio stream itself carries on."""
        self._utterance: int | None = None
        self._frames: list[np.ndarray] = []
        self._turn_start = 0
        self._turn_has_speech = False
        self._partial_due = False
        self._turns: list[tuple[str, str | None]] = []
        self._endpointer = Endpointer()

    async def run(self) -> None:
        reader = asyncio.create_task(self._read())
        try:
            while (message := await self._next())["type"] != "websocket.disconnect":
                await self._handle(message)
        except WebSocketDisconnect:
            pass
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    async def _read(self) -> None:
        """Takes messages as they come: audio that arrives while the model thread is busy waits here, so the
        next model-thread turn can check all of it at once instead of one frame per turn."""
        try:
            while (message := await self._socket.receive())["type"] != "websocket.disconnect":
                self._inbox.append(message)
                self._arrived.set()
        finally:
            self._inbox.append({"type": "websocket.disconnect"})
            self._arrived.set()

    async def _next(self) -> Message:
        while not self._inbox:
            self._arrived.clear()
            await self._arrived.wait()
        return self._inbox.popleft()

    async def _handle(self, message: Message) -> None:
        try:
            if message.get("bytes") is not None:
                await self._audio([message["bytes"], *self._waiting_audio()])
            elif message.get("text") is not None:
                await self._control(message["text"])
        except WebSocketDisconnect:
            raise
        except Exception as failure:
            await self._report("recognition_failed", failure)
            # Listening stops, so a broken detector answers once rather than every frame.
            self._stop()

    def _waiting_audio(self) -> list[bytes]:
        waiting = []
        while self._inbox and self._inbox[0].get("bytes") is not None:
            waiting.append(self._inbox.popleft()["bytes"])
        return waiting

    async def _control(self, text: str) -> None:
        try:
            message = json.loads(text)
        except ValueError:
            message = None
        kind = message.get("type") if isinstance(message, dict) else None
        if kind == "listen" and message.get("mode") in ("ptt", "handsfree"):
            await self._listen(message["mode"])
        elif kind == "release":
            await self._release()
        else:
            await self._send({"type": "error", "code": "bad_request", "message": "unknown message"})

    async def _listen(self, mode: str) -> None:
        self._stop()
        vad = self._engines.slots["vad"]
        try:
            await self._worker.run(self._engines.slots["asr"].get)
            # A fresh Silero state per listening phase, made on the model thread like every MLX call.
            self._probe = await self._worker.run(lambda: vad.get()())
        except Exception as failure:
            await self._report("unavailable", failure)
            return
        self._mode = mode
        if mode == "ptt":
            self._open()
        await self._send({"type": "ready"})

    async def _release(self) -> None:
        """Push-to-talk let go, or hands-free stopped: what was said so far is finished and sent."""
        if self._utterance is not None and self._carry.size:
            self._frames.append(self._carry)
        await self._finish()
        self._stop()

    async def _audio(self, chunks: list[bytes]) -> None:
        if self._mode is None:
            return
        whole = []
        for data in chunks:
            if len(data) % 2:
                await self._send({"type": "error", "code": "bad_request", "message": "audio must be whole 16-bit samples"})
            else:
                whole.append(np.frombuffer(data, dtype="<i2"))
        samples = np.concatenate([self._carry, *whole])
        usable = samples.size - samples.size % FRAME
        frames, self._carry = samples[:usable].reshape(-1, FRAME), samples[usable:]
        for start in range(0, len(frames), BATCH_FRAMES):
            batch = frames[start : start + BATCH_FRAMES]
            probabilities = await self._worker.run(hear, self._probe, batch)
            for frame, probability in zip(batch, probabilities, strict=True):
                await self._frame(frame, probability)
            if self._partial_due:
                await self._partial()

    async def _frame(self, frame: np.ndarray, probability: float) -> None:
        self._frames.append(frame)
        if self._utterance is None:
            # Speech is only confirmed on its third frame, so those frames are kept on top of the preroll.
            del self._frames[: -(PREROLL_FRAMES + MIN_SPEECH_FRAMES - 1)]
        for event in self._endpointer.push(probability, FRAME_MS):
            if event.kind == "speech_started":
                self._turn_has_speech = True
                if self._utterance is None:
                    self._open()
                await self._send({"type": "speech_started", "utterance": self._utterance})
            elif event.kind == "partial_due" and self._utterance is not None:
                # Decoded once the batch is checked, so a backlog brings one partial, not one per 500 ms.
                self._partial_due = True
            elif event.kind == "turn_ended" and self._utterance is not None:
                await self._end_turn()
            elif event.kind == "utterance_ended" and self._mode == "handsfree":
                await self._finish()
        if self._mode is not None and len(self._frames) >= MAX_FRAMES[self._mode]:
            await self._finish()

    def _open(self) -> None:
        self._utterances += 1
        self._utterance = self._utterances

    async def _partial(self) -> None:
        self._partial_due = False
        decoded = await self._decode(self._frames[self._turn_start :])
        if decoded is not None:
            parts = [t for t, _ in self._turns] + [decoded[0]]
            await self._send({"type": "partial", "utterance": self._utterance, "text": join_texts(parts)})

    async def _end_turn(self) -> None:
        self._partial_due = False
        decoded = await self._decode(self._frames[self._turn_start :])
        self._turns.append(decoded or ("", None))
        self._turn_start = len(self._frames)
        self._turn_has_speech = False
        if decoded is not None:
            await self._send({"type": "final", "utterance": self._utterance, **self._result()})

    async def _finish(self) -> None:
        if self._utterance is None:
            return
        if self._turn_has_speech or (self._mode == "ptt" and not self._turns):
            await self._end_turn()
        await self._send({"type": "end", "utterance": self._utterance, **self._result()})
        self._reset()

    def _result(self) -> dict:
        texts = [t for t, _ in self._turns]
        longest = max(self._turns, key=lambda turn: len(turn[0]), default=("", None))
        return {"text": join_texts(texts), "lang": longest[1]}

    async def _decode(self, frames: list[np.ndarray]) -> tuple[str, str | None] | None:
        """The text and language of some audio, or None once a failure has been reported."""
        if not frames:
            return "", None
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        asr = self._engines.slots["asr"]
        try:
            # Taken from its slot for every decode, so an idle unload frees the model while a session listens on.
            return await self._worker.run(lambda: asr.get().transcribe(audio))
        except Exception as failure:
            refused = isinstance(failure, (LoadRefused, LoadFailed))
            await self._report("unavailable" if refused else "recognition_failed", failure)
            return None

    async def _report(self, code: str, failure: Exception) -> None:
        """A refused or failed load already says why; anything else is unexpected, so it is logged."""
        if isinstance(failure, (LoadRefused, LoadFailed)):
            message = str(failure)
        else:
            log.error("%s (utterance %s)", code, self._utterance, exc_info=failure)
            message = describe(failure)
        await self._send({"type": "error", "code": code, "message": message})

    async def _send(self, message: dict) -> None:
        await self._socket.send_json(message)
