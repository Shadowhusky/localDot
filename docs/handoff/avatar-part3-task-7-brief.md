### Task 7: voiced listens — Silero end of speech, Qwen3-ASR, push-to-talk and hands-free

**Files:**
- Create: `apps/voiced/src/voiced/{endpoint,listen,stt}.py`
- Modify: `apps/voiced/src/voiced/engines.py` (`asr` and `vad` slots), `apps/voiced/src/voiced/app.py` (`/stt`)
- Test: `apps/voiced/tests/conftest.py` (add `FakeRecognizer`, `FakeProbe`), `apps/voiced/tests/{test_endpoint,test_stt}.py`, `apps/voiced/tests/test_models.py` (ASR and VAD)

**Interfaces:**
- Consumes (Tasks 1–3): `Engines`, `model_slot`, `Worker`, `LoadRefused`, `LoadFailed`, `describe`, `MIC_SAMPLE_RATE`, `accept`, conftest helpers, `first_audio` and `stock` in `test_models.py`.
- Produces:
  - `voiced.endpoint`: `SILENCE_MS = 500`, `MERGE_MS = 1000`, `PARTIAL_EVERY_MS = 500`, `THRESHOLD = 0.5`, `EndpointEvent(kind, utterance, at_ms)` with kinds `"speech_started" | "turn_ended" | "utterance_ended" | "partial_due"`, `Endpointer(silence_ms, merge_ms).push(probability, frame_ms) -> list[EndpointEvent]` (audio time, so tests are exact).
  - `voiced.listen`: `ASR_FAST`, `ASR_ACCURATE` (`LOCALDOT_ASR=accurate`), `VAD`, `ASR_LANGS`, `MlxRecognizer(model).transcribe(audio16k) -> (text, "zh" | "en" | "ja" | None)`, `load_recognizer(accurate)`, `SileroProbe(model).probability(frame512) -> float`, `load_vad() -> () -> SileroProbe`.
  - `voiced.stt`: `FRAME = 512` (32 ms at 16 kHz), `PREROLL_FRAMES = 10`, `MAX_FRAMES` (60 s hands-free, 120 s push-to-talk), `join_texts(parts)`, `SttSession(socket, engines, worker).run()`.
  - `/stt` protocol (Task 9's browser side mirrors it): client JSON `{"type":"listen","mode":"ptt"|"handsfree"}`, binary int16 LE mono 16 kHz PCM in any chunk size, `{"type":"release"}` (push-to-talk release, or stop listening); server JSON `{"type":"ready"}` after each `listen`, `{"type":"speech_started","utterance"}`, `{"type":"partial","utterance","text"}` (about every 500 ms of speech), `{"type":"final","utterance","text","lang"}` (each turn's end: 500 ms of silence, or release), `{"type":"end","utterance","text","lang"}` (hands-free: once a pause reaches 1 s; push-to-talk: on release), `{"type":"error","code":"bad_request"|"unavailable"|"recognition_failed","message"}`. Each turn is decoded once; `final` and `end` carry all turns joined.
  - `mlx_engines(settings).slots["asr"]`, `["vad"]` (VAD is not LM-Studio-guarded: it is 2 MB).

- [ ] **Step 1: Write the failing tests**

Append to `apps/voiced/tests/conftest.py`:
```python


class FakeRecognizer:
    """Says how much audio it heard, e.g. "1.2s", so tests can tell which audio was decoded."""

    def __init__(self, lang: str | None = "en") -> None:
        self.lang = lang
        self.heard: list[float] = []

    def transcribe(self, audio):
        seconds = round(audio.size / 16_000, 2)
        self.heard.append(seconds)
        return f"{seconds}s", self.lang


class FakeProbe:
    """Speech wherever the frame is loud."""

    def probability(self, frame):
        return 0.9 if float(np.abs(frame).mean()) > 0.1 else 0.0
```

`apps/voiced/tests/test_endpoint.py`:
```python
from voiced.endpoint import Endpointer

FRAME_MS = 32


def run(pattern):
    """pattern: list of (probability, milliseconds); returns events as (kind, utterance, at_ms)."""
    ep = Endpointer()
    events = []
    for probability, ms in pattern:
        for _ in range(round(ms / FRAME_MS)):
            events += [(e.kind, e.utterance, e.at_ms) for e in ep.push(probability, FRAME_MS)]
    return [e for e in events if e[0] != "partial_due"]


def test_a_turn_ends_after_500_ms_of_silence_and_the_utterance_after_1_s():
    events = run([(0.0, 320), (0.9, 640), (0.0, 1280)])
    assert events == [
        ("speech_started", 1, 320),
        ("turn_ended", 1, 1472),
        ("utterance_ended", 1, 1984),
    ]


def test_a_pause_shorter_than_1_s_joins_the_same_utterance():
    events = run([(0.9, 640), (0.0, 704), (0.9, 320), (0.0, 1280)])
    assert events == [
        ("speech_started", 1, 0),
        ("turn_ended", 1, 1152),
        ("speech_started", 1, 1344),
        ("turn_ended", 1, 2176),
        ("utterance_ended", 1, 2688),
    ]


def test_a_pause_of_1_s_or_more_starts_a_new_utterance():
    events = run([(0.9, 320), (0.0, 1024), (0.9, 320), (0.0, 1024)])
    assert [e[:2] for e in events] == [
        ("speech_started", 1),
        ("turn_ended", 1),
        ("utterance_ended", 1),
        ("speech_started", 2),
        ("turn_ended", 2),
        ("utterance_ended", 2),
    ]


def test_short_dips_inside_speech_do_not_end_the_turn():
    events = run([(0.9, 320), (0.0, 448), (0.9, 320), (0.0, 1024)])
    assert [e[0] for e in events] == ["speech_started", "turn_ended", "utterance_ended"]


def test_partials_are_due_every_500_ms_of_speech_only():
    ep = Endpointer()
    due = []
    for i in range(round(2000 / FRAME_MS)):
        probability = 0.9 if i * FRAME_MS < 1200 else 0.0
        due += [e.at_ms for e in ep.push(probability, FRAME_MS) if e.kind == "partial_due"]
    assert due == [512, 1024]


def test_silence_alone_never_opens_an_utterance():
    assert run([(0.2, 5000)]) == []
```

`apps/voiced/tests/test_stt.py`:
```python
import json

import numpy as np

from conftest import WS_PROTOCOLS, WS_URL, FakeProbe, FakeRecognizer, client, engines, slot
from voiced.stt import join_texts

CHUNK = 480


def pcm(seconds: float, loud: bool) -> bytes:
    return np.full(round(seconds * 16_000), 9830 if loud else 0, dtype="<i2").tobytes()


def stream(socket, *parts: tuple[float, bool]) -> None:
    audio = b"".join(pcm(s, loud) for s, loud in parts)
    for i in range(0, len(audio), CHUNK * 2):
        socket.send_bytes(audio[i : i + CHUNK * 2])


def listening(recognizer=None, asr=None):
    asr = asr or slot(recognizer or FakeRecognizer())
    return client(engines(asr=asr, vad=slot(FakeProbe))).websocket_connect(f"{WS_URL}/stt", subprotocols=WS_PROTOCOLS)


def until(socket, kind):
    seen = []
    while True:
        message = socket.receive_json()
        seen.append(message)
        if message["type"] == kind:
            return seen


def test_push_to_talk_decodes_everything_from_press_to_release():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        assert socket.receive_json() == {"type": "ready"}
        stream(socket, (1.0, True), (0.2, False))
        socket.send_text(json.dumps({"type": "release"}))
        seen = until(socket, "end")
    kinds = [m["type"] for m in seen]
    assert kinds[0] == "speech_started" and kinds[-2:] == ["final", "end"]
    assert seen[-1] == {"type": "end", "utterance": 1, "text": "1.2s", "lang": "en"}
    assert "partial" in kinds


def test_hands_free_ends_a_turn_after_half_a_second_and_the_utterance_after_a_second():
    with listening() as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.4, False), (1.0, True), (1.2, False))
        seen = until(socket, "end")
    finals = [m for m in seen if m["type"] == "final"]
    assert seen[0] == {"type": "speech_started", "utterance": 1}
    assert len(finals) == 1 and finals[0]["text"] == seen[-1]["text"] == "1.82s"


def test_a_pause_under_a_second_keeps_one_utterance_and_decodes_each_turn_once():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.6, True), (0.7, False), (0.6, True), (1.2, False))
        seen = until(socket, "end")
    finals = [m["text"] for m in seen if m["type"] == "final"]
    assert [m["utterance"] for m in seen if m["type"] == "speech_started"] == [1, 1]
    assert len(finals) == 2 and finals[1] == seen[-1]["text"]
    assert seen[-1]["text"].count("s") == 2


def test_a_long_pause_starts_a_second_utterance():
    with listening() as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "handsfree"}))
        socket.receive_json()
        stream(socket, (0.5, True), (1.2, False), (0.5, True), (1.2, False))
        first = until(socket, "end")
        second = until(socket, "end")
    assert (first[-1]["utterance"], second[-1]["utterance"]) == (1, 2)


def test_a_refused_speech_model_is_reported_on_listen():
    refused = slot(FakeRecognizer(), guard=lambda: "LM Studio has big loaded (44.5 GB)")
    with listening(asr=refused) as socket:
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        reply = socket.receive_json()
    assert (reply["type"], reply["code"]) == ("error", "unavailable")


def test_audio_before_listen_is_ignored():
    recognizer = FakeRecognizer()
    with listening(recognizer) as socket:
        stream(socket, (1.0, True), (1.2, False))
        socket.send_text(json.dumps({"type": "listen", "mode": "ptt"}))
        assert socket.receive_json() == {"type": "ready"}
    assert recognizer.heard == []


def test_joins_turns_without_spaces_between_cjk_text():
    assert join_texts(["你好。", "我在。"]) == "你好。我在。"
    assert join_texts(["Hello.", "我在。", "OK"]) == "Hello. 我在。 OK"
    assert join_texts(["", " hi "]) == "hi"
```

In `apps/voiced/tests/test_models.py`, add `import re` after `import os` and `import unicodedata`
after `import time`, then append:
```python


def to_16k(audio: np.ndarray, rate: int) -> np.ndarray:
    from mlx_audio.resample import resample_audio_array

    return resample_audio_array(np.asarray(audio, dtype=np.float32), rate, 16_000)


def normalise(text: str) -> str:
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", text).lower())


def error_rate(expected: str, heard: str) -> float:
    a, b = normalise(expected), normalise(heard)
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        previous, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (ca != cb))
    return row[len(b)] / max(len(a), 1)


@pytest.fixture(scope="module")
def recognizer():
    from voiced.listen import load_recognizer

    loaded = load_recognizer(accurate=False)
    loaded.transcribe(np.zeros(16_000, dtype=np.float32))
    return loaded


@pytest.mark.parametrize(("lang", "text"), LINES[:2])
def test_push_to_talk_decodes_a_spoken_line_within_budget(stock, recognizer, lang, text):
    _, audio = first_audio(stock, text, lang)
    clip = to_16k(audio, stock.sample_rate)
    started = time.perf_counter()
    heard, heard_lang = recognizer.transcribe(clip)
    assert time.perf_counter() - started < 0.4
    assert heard_lang == lang
    assert error_rate(text, heard) <= 0.1, heard


def test_silero_hears_speech_and_not_silence(stock):
    from voiced.listen import load_vad

    new_probe = load_vad()
    _, audio = first_audio(stock, "Hey, you're finally back.", "en")
    clip = to_16k(audio, stock.sample_rate)
    speaking = new_probe()
    speech = [speaking.probability(clip[i : i + 512]) for i in range(0, clip.size - 512, 512)]
    quiet = new_probe()
    silence = [quiet.probability(np.zeros(512, dtype=np.float32)) for _ in range(30)]
    assert max(speech) > 0.5 and max(silence) < 0.5
```
(Japanese is left out of the strict recognition check: V0-5 measured 8–23% CER on synthetic clips, an
open risk for real speech.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm test:voiced`
Expected: FAIL — `ModuleNotFoundError: No module named 'voiced.endpoint'`.

- [ ] **Step 3: Implement**

`apps/voiced/src/voiced/endpoint.py`:
```python
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
```

`apps/voiced/src/voiced/listen.py`:
```python
"""Qwen3-ASR and Silero VAD on MLX: what was said, and whether anyone is speaking."""

from typing import Any

import numpy as np

ASR_FAST = "mlx-community/Qwen3-ASR-0.6B-8bit"
ASR_ACCURATE = "mlx-community/Qwen3-ASR-1.7B-8bit"
VAD = "mlx-community/silero-vad"
ASR_LANGS = {"chinese": "zh", "cantonese": "zh", "english": "en", "japanese": "ja"}


class MlxRecognizer:
    def __init__(self, model: Any) -> None:
        self.model = model

    def transcribe(self, audio: np.ndarray) -> tuple[str, str | None]:
        result = self.model.generate(np.asarray(audio, dtype=np.float32))
        language = result.language[0] if isinstance(result.language, list) and result.language else result.language
        return str(result.text).strip(), ASR_LANGS.get(str(language or "").lower())


def load_recognizer(accurate: bool) -> MlxRecognizer:
    from mlx_audio.stt import load

    return MlxRecognizer(load(ASR_ACCURATE if accurate else ASR_FAST))


class SileroProbe:
    """Silero's streaming state for one listening session; the model itself is shared."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.state = model.initial_state(sample_rate=16_000)

    def probability(self, frame: np.ndarray) -> float:
        import mlx.core as mx

        probability, self.state = self.model.feed(frame, self.state, sample_rate=16_000)
        mx.eval(probability)
        return float(np.asarray(probability).reshape(-1)[0])


def load_vad() -> Any:
    from mlx_audio.vad.utils import load

    model = load(VAD)
    return lambda: SileroProbe(model)
```

`apps/voiced/src/voiced/stt.py`:
```python
"""One /stt connection: microphone PCM in, speech start, partial, final and end-of-utterance out."""

import json
import re
from typing import Any

import numpy as np
from starlette.websockets import WebSocket, WebSocketDisconnect

from voiced.endpoint import Endpointer
from voiced.engines import Engines
from voiced.slots import LoadFailed, LoadRefused
from voiced.tts import describe
from voiced.wire import MIC_SAMPLE_RATE
from voiced.worker import Worker

FRAME = 512
FRAME_MS = 1000 * FRAME / MIC_SAMPLE_RATE
PREROLL_FRAMES = 10
MAX_FRAMES = {"handsfree": round(60_000 / FRAME_MS), "ptt": round(120_000 / FRAME_MS)}
CJK = re.compile(r"[\U00003000-\U000030ff\U00003400-\U00004dbf\U00004e00-\U00009fff\U0000f900-\U0000faff\U0000ff00-\U0000ffef]")


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


class SttSession:
    def __init__(self, socket: WebSocket, engines: Engines, worker: Worker) -> None:
        self._socket = socket
        self._engines = engines
        self._worker = worker
        self._mode: str | None = None
        self._utterances = 0
        self._recognizer: Any = None
        self._probe: Any = None
        self._endpointer = Endpointer()
        self._reset()

    def _reset(self) -> None:
        self._utterance: int | None = None
        self._frames: list[np.ndarray] = []
        self._turn_start = 0
        self._turn_has_speech = False
        self._turns: list[tuple[str, str | None]] = []
        self._carry = np.zeros(0, dtype=np.int16)

    async def run(self) -> None:
        try:
            while True:
                message = await self._socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    await self._audio(message["bytes"])
                elif message.get("text") is not None:
                    await self._control(message["text"])
        except WebSocketDisconnect:
            pass

    async def _control(self, text: str) -> None:
        try:
            message = json.loads(text)
        except ValueError:
            message = None
        kind = message.get("type") if isinstance(message, dict) else None
        if kind == "listen" and message.get("mode") in ("ptt", "handsfree"):
            await self._listen(message["mode"])
        elif kind == "release":
            await self._finish()
            self._mode = None
        else:
            await self._send({"type": "error", "code": "bad_request", "message": "unknown message"})

    async def _listen(self, mode: str) -> None:
        vad = self._engines.slots["vad"]
        try:
            self._recognizer = await self._worker.run(self._engines.slots["asr"].get)
            # A fresh Silero state per listening phase, made on the model thread like every MLX call.
            self._probe = await self._worker.run(lambda: vad.get()())
        except (LoadRefused, LoadFailed) as failure:
            await self._send({"type": "error", "code": "unavailable", "message": str(failure)})
            return
        self._endpointer = Endpointer()
        self._mode = mode
        self._reset()
        if mode == "ptt":
            self._open()
        await self._send({"type": "ready"})

    async def _audio(self, data: bytes) -> None:
        if self._mode is None or len(data) % 2:
            return
        self._carry = np.concatenate([self._carry, np.frombuffer(data, dtype="<i2")])
        while self._carry.size >= FRAME:
            frame, self._carry = self._carry[:FRAME], self._carry[FRAME:]
            await self._frame(frame)

    async def _frame(self, frame: np.ndarray) -> None:
        probability = await self._worker.run(self._probe.probability, frame.astype(np.float32) / 32768.0)
        self._frames.append(frame)
        if self._utterance is None:
            del self._frames[:-PREROLL_FRAMES]
        for event in self._endpointer.push(probability, FRAME_MS):
            if event.kind == "speech_started":
                self._turn_has_speech = True
                if self._utterance is None:
                    self._open()
                await self._send({"type": "speech_started", "utterance": self._utterance})
            elif event.kind == "partial_due" and self._utterance is not None:
                text, _ = await self._decode(self._frames[self._turn_start :])
                parts = [t for t, _ in self._turns] + [text]
                await self._send({"type": "partial", "utterance": self._utterance, "text": join_texts(parts)})
            elif event.kind == "turn_ended" and self._utterance is not None:
                await self._end_turn()
            elif event.kind == "utterance_ended" and self._mode == "handsfree":
                await self._finish()
        if self._mode is not None and len(self._frames) >= MAX_FRAMES[self._mode]:
            await self._finish()

    def _open(self) -> None:
        self._utterances += 1
        self._utterance = self._utterances

    async def _end_turn(self) -> None:
        text, lang = await self._decode(self._frames[self._turn_start :])
        self._turns.append((text, lang))
        self._turn_start = len(self._frames)
        self._turn_has_speech = False
        await self._send({"type": "final", "utterance": self._utterance, **self._result()})

    async def _finish(self) -> None:
        if self._utterance is None:
            return
        if self._carry.size:
            self._frames.append(self._carry)
            self._carry = np.zeros(0, dtype=np.int16)
        if self._turn_has_speech or (self._mode == "ptt" and not self._turns):
            await self._end_turn()
        await self._send({"type": "end", "utterance": self._utterance, **self._result()})
        self._reset()
        self._endpointer = Endpointer()

    def _result(self) -> dict:
        texts = [t for t, _ in self._turns]
        longest = max(self._turns, key=lambda turn: len(turn[0]), default=("", None))
        return {"text": join_texts(texts), "lang": longest[1]}

    async def _decode(self, frames: list[np.ndarray]) -> tuple[str, str | None]:
        if not frames:
            return "", None
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        try:
            return await self._worker.run(self._recognizer.transcribe, audio)
        except Exception as failure:
            await self._send({"type": "error", "code": "recognition_failed", "message": describe(failure)})
            return "", None

    async def _send(self, message: dict) -> None:
        await self._socket.send_json(message)
```

In `apps/voiced/src/voiced/engines.py`, add `from voiced.listen import load_recognizer, load_vad`
after the `from voiced.config import Settings` import, and replace `mlx_engines` with:
```python
def mlx_engines(settings: Settings) -> Engines:
    return Engines(
        voice="pack" if settings.voice else "stock",
        slots={
            "tts": model_slot(settings, lambda: load_synthesizer(settings.voice)),
            "aligner": model_slot(settings, load_aligner),
            "asr": model_slot(settings, lambda: load_recognizer(settings.accurate_asr)),
            "vad": model_slot(settings, load_vad, guarded=False),
        },
    )
```

In `apps/voiced/src/voiced/app.py`, add `from voiced.stt import SttSession` after the
`voiced.guard` import; inside `create_app`, add after the `tts` function:
```python
    async def stt(socket: WebSocket) -> None:
        await accept(socket)
        await SttSession(socket, engines, model_worker).run()
```
and add `WebSocketRoute("/stt", stt),` after `WebSocketRoute("/tts", tts),` in `routes`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm test:voiced`
Expected: `60 passed, 10 deselected`.

- [ ] **Step 5: Tell the core session, check LM Studio, run the model tests**

Coordination message (task "Task 7", about 5 minutes) and the LM Studio check, as in Global
Constraints; wait for the go-ahead. Then:
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar/apps/voiced" && HF_HUB_OFFLINE=1 uv run pytest -m models -q -k "push_to_talk or silero"
```
Expected: `3 passed` — a whole Chinese and English line decodes in under 400 ms (V0-5: 111–135 ms) with
the right language and at most 10% error, and Silero separates speech from silence.

- [ ] **Step 6: Check and commit**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm lint && pnpm typecheck && pnpm hygiene && \
git add apps/voiced/src apps/voiced/tests && git commit -m "feat(voiced): push-to-talk and hands-free speech input with turn merging"
```

Expected: exit 0; one commit.

---

