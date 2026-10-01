"""One /tts connection: sentences in, audio frames and the end of each sentence out, in order."""

import asyncio
import json

import numpy as np
from starlette.websockets import WebSocket, WebSocketDisconnect

from voiced.engines import Engines
from voiced.slots import LoadFailed, LoadRefused
from voiced.wire import Say, encode_audio_frame, error, parse_say, to_int16, valid_id
from voiced.worker import Worker


def describe(failure: BaseException) -> str:
    return f"{type(failure).__name__}: {failure}"


class TtsSession:
    def __init__(self, socket: WebSocket, engines: Engines, worker: Worker) -> None:
        self._socket = socket
        self._engines = engines
        self._worker = worker
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
        while True:
            say, generation = await self._queue.get()
            if generation == self._generation:
                await self._speak(say, generation)

    async def _speak(self, say: Say, generation: int) -> None:
        try:
            synth = await self._worker.run(self._engines.slots["tts"].get)
        except (LoadRefused, LoadFailed) as failure:
            await self._socket.send_json(error(say.id, "unavailable", str(failure)))
            return
        stream = synth.stream(say.text, say.lang)
        chunks: list[np.ndarray] = []
        try:
            while generation == self._generation:
                try:
                    chunk = await self._worker.run(next, stream, None)
                except Exception as failure:
                    await self._socket.send_json(error(say.id, "synthesis_failed", describe(failure)))
                    return
                if chunk is None:
                    break
                await self._socket.send_bytes(encode_audio_frame(say.id, len(chunks), to_int16(chunk)))
                chunks.append(chunk)
        finally:
            await self._worker.run(stream.close)
        if generation != self._generation:
            return
        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        await self._socket.send_json({"type": "end", "id": say.id, "samples": int(audio.size)})
