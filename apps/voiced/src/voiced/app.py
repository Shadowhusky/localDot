"""voiced's HTTP and WebSocket routes behind the request guard."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp

from voiced.config import Settings
from voiced.engines import Engines
from voiced.guard import Guard
from voiced.worker import Worker

SWEEP_EVERY_S = 30.0


def create_app(settings: Settings, engines: Engines, worker: Worker | None = None) -> ASGIApp:
    model_worker = worker or Worker()

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "voice": engines.voice, "slots": engines.status()})

    @asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        sweeper = asyncio.create_task(sweep_forever(engines, model_worker))
        yield
        sweeper.cancel()
        model_worker.close()

    app = Starlette(routes=[Route("/health", health)], lifespan=lifespan)
    return Guard(app, settings.token, settings.port)


async def sweep_forever(engines: Engines, worker: Worker) -> None:
    while True:
        await asyncio.sleep(SWEEP_EVERY_S)
        await worker.run(engines.sweep)
