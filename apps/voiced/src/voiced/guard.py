"""Only the host that started voiced may use it: right Host, no browser Origin, the token."""

import hmac
from dataclasses import dataclass

from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN_PROTOCOL_PREFIX = "localdot.token."
PROTOCOL = "localdot.v1"


@dataclass(frozen=True)
class Refusal:
    status: int
    close_code: int
    reason: str


def offered_protocols(headers: dict[str, str]) -> list[str]:
    return [p.strip() for p in headers.get("sec-websocket-protocol", "").split(",") if p.strip()]


def given_token(headers: dict[str, str]) -> str | None:
    bearer = headers.get("authorization", "")
    if bearer.startswith("Bearer "):
        return bearer[len("Bearer ") :]
    for protocol in offered_protocols(headers):
        if protocol.startswith(TOKEN_PROTOCOL_PREFIX):
            return protocol[len(TOKEN_PROTOCOL_PREFIX) :]
    return None


def refusal(headers: dict[str, str], token: str, port: int) -> Refusal | None:
    if headers.get("host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
        return Refusal(403, 4403, "forbidden host")
    # Browsers always send Origin; voiced has no browser clients, only the host process.
    if "origin" in headers:
        return Refusal(403, 4403, "forbidden origin")
    given = given_token(headers)
    if given is None or not hmac.compare_digest(given.encode(), token.encode()):
        return Refusal(401, 4401, "unauthorized")
    return None


class Guard:
    def __init__(self, app: ASGIApp, token: str, port: int) -> None:
        self.app = app
        self.token = token
        self.port = port

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        problem = refusal(headers, self.token, self.port)
        if problem is None:
            await self.app(scope, receive, send)
        elif scope["type"] == "http":
            await PlainTextResponse(problem.reason, status_code=problem.status)(scope, receive, send)
        else:
            await receive()
            await send({"type": "websocket.close", "code": problem.close_code})
