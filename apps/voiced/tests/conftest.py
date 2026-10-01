from starlette.testclient import TestClient

from voiced.app import create_app
from voiced.config import Settings
from voiced.engines import Engines
from voiced.slots import ModelSlot

TOKEN = "t" * 43
BASE_URL = "http://127.0.0.1:4752"
# websocket_connect ignores base_url for relative paths, so sockets use this absolute form.
WS_URL = "ws://127.0.0.1:4752"
AUTH = {"authorization": f"Bearer {TOKEN}"}
WS_PROTOCOLS = ["localdot.v1", f"localdot.token.{TOKEN}"]


def slot(value: object, guard=None) -> ModelSlot:
    return ModelSlot(lambda: value, idle_unload_s=600, guard=guard)


def engines(**slots: ModelSlot) -> Engines:
    return Engines(voice="stock", slots=slots)


def client(app_engines: Engines) -> TestClient:
    return TestClient(create_app(Settings(token=TOKEN), app_engines), base_url=BASE_URL)
