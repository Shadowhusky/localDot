"""One /tts connection: sentences in, audio frames and the end of each sentence out, in order."""

import asyncio
import contextlib
import json
import logging
from typing import Any

import numpy as np
from starlette.websockets import WebSocket, WebSocketDisconnect

from voiced.engines import Engines
from voiced.slots import LoadFailed, LoadRefused
from voiced.wire import Say, encode_audio_frame, error, parse_say, to_int16, valid_id
from voiced.worker import Worker

log = logging.getLogger(__name__)


def describe(failure: BaseException) -> str:
    return f"{type(failure).__name__}: {failure}"


class TtsSession:
    def __init__(self, socket: WebSocket, engines: Engines, worker: Worker, tts_lock: asyncio.Lock) -> None:
        self._socket = socket
        self._engines = engines
        self._worker = worker
        # mlx-audio keeps a stream's decoder state on the shared model, so sessions take turns per sentence.
        self._tts_lock = tts_lock
        self._queue: asyncio.Queue[tuple[Say, int]] = asyncio.Queue()
        # A cancel bumps the generation; anything said under an older one is dropped.
        self._generation = 0

    async def run(self) -> None:
        await self._socket.send_json({"type": "ready", "voice": self._engines.voice})
        speaker = asyncio.create_task(self._speak_queued())
        try:
            while True:
                message = await self._socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("text") is not None:
                    await self._handle(message["text"])
        except WebSocketDisconnect:
            pass
        finally:
            speaker.cancel()

    async def _handle(self, text: str) -> None:
        try:
            message = json.loads(text)
        except ValueError:
            await self._socket.send_json(error(None, "bad_request", "not JSON"))
            return
        kind = message.get("type") if isinstance(message, dict) else None
        if kind == "cancel":
            self._generation += 1
            return
        if kind != "say":
            await self._socket.send_json(error(None, "bad_request", "unknown message"))
            return
        say = parse_say(message)
        if isinstance(say, str):
            sentence_id = message.get("id")
            await self._socket.send_json(error(sentence_id if valid_id(sentence_id) else None, say, "sentence refused"))
            return
        self._queue.put_nowait((say, self._generation))

    async def _speak_queued(self) -> None:
        with contextlib.suppress(WebSocketDisconnect):
            # Loading as the session opens spares the first sentence the cold load.
            await self._load(None, self._generation)
            while True:
                say, generation = await self._queue.get()
                if generation == self._generation:
                    await self._speak(say, generation)

    async def _load(self, sentence_id: int | None, generation: int) -> Any:
        """The voice, loaded if need be; None once the failure has been reported."""
        try:
            return await self._worker.run(self._engines.slots["tts"].get)
        except Exception as failure:
            await self._report(failure, sentence_id, generation, "unavailable")
            return None

    async def _speak(self, say: Say, generation: int) -> None:
        synth = await self._load(say.id, generation)
        if synth is None:
            return
        try:
            audio = await self._stream(synth, say, generation)
        except WebSocketDisconnect:
            raise
        except Exception as failure:
            await self._report(failure, say.id, generation, "synthesis_failed")
            return
        if generation != self._generation:
            return
        await self._socket.send_json({"type": "end", "id": say.id, "samples": int(audio.size)})

    async def _stream(self, synth: Any, say: Say, generation: int) -> np.ndarray:
        chunks: list[np.ndarray] = []
        async with self._tts_lock:
            stream = synth.stream(say.text, say.lang)
            try:
                while generation == self._generation:
                    chunk = await self._worker.run(next, stream, None)
                    if chunk is None or generation != self._generation:
                        break
                    await self._socket.send_bytes(encode_audio_frame(say.id, len(chunks), to_int16(chunk)))
                    chunks.append(chunk)
            finally:
                await self._worker.run(stream.close)
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

    async def _report(self, failure: Exception, sentence_id: int | None, generation: int, code: str) -> None:
        """A refused or failed load already says why; anything else is unexpected, so it is logged."""
        if isinstance(failure, (LoadRefused, LoadFailed)):
            message = str(failure)
        else:
            log.error("%s (sentence %s)", code, sentence_id, exc_info=failure)
            message = describe(failure)
        if generation == self._generation:
            await self._socket.send_json(error(sentence_id, code, message))
