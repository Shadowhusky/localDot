"""voiced's HTTP and WebSocket routes behind the request guard."""

import asyncio
import logging
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.types import ASGIApp
from starlette.websockets import WebSocket

from voiced.config import Settings
from voiced.engines import Engines
from voiced.guard import PROTOCOL, Guard, offered_protocols
from voiced.tts import TtsSession
from voiced.visemes import Unit, build_track
from voiced.wire import LANGS
from voiced.worker import Worker

SWEEP_EVERY_S = 30.0
MAX_UNITS = 2000

log = logging.getLogger(__name__)


def create_app(settings: Settings, engines: Engines, worker: Worker | None = None) -> ASGIApp:
    model_worker = worker or Worker()
    tts_lock = asyncio.Lock()

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "voice": engines.voice, "slots": engines.status()})

    async def tts(socket: WebSocket) -> None:
        await accept(socket)
        await TtsSession(socket, engines, model_worker, tts_lock).run()

    async def visemes(request: Request) -> JSONResponse:
        """Mouth shapes for a cloud voice's own timings (ElevenLabs gives one per character)."""
        try:
            body = await request.json()
            lang = body["lang"]
            units = [Unit(str(u["text"]), float(u["start"]), float(u["end"])) for u in body["units"]]
            finite = all(math.isfinite(u.start) and math.isfinite(u.end) for u in units)
            if lang not in LANGS or len(units) > MAX_UNITS or not finite:
                raise ValueError(lang)
        except (ValueError, KeyError, TypeError):
            return JSONResponse({"error": "bad_request"}, status_code=400)
        return JSONResponse({"visemes": await model_worker.run(build_track, units, lang)})

    @asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        sweeper = asyncio.create_task(sweep_forever(engines, model_worker))
        yield
        sweeper.cancel()
        model_worker.close()

    routes = [
        Route("/health", health),
        Route("/visemes", visemes, methods=["POST"]),
        WebSocketRoute("/tts", tts),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    return Guard(app, settings.token, settings.port)


async def accept(socket: WebSocket) -> None:
    # A browser-style client fails the handshake unless the server picks one of its subprotocols.
    offered = offered_protocols(dict(socket.headers.items()))
    await socket.accept(subprotocol=PROTOCOL if PROTOCOL in offered else None)


async def sweep_forever(engines: Engines, worker: Worker) -> None:
    while True:
        await asyncio.sleep(SWEEP_EVERY_S)
        try:
            await worker.run(engines.sweep)
        except Exception:
            log.exception("model sweep failed")
