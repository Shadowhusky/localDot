"""V0-5: local speech input — Silero VAD endpointing plus Qwen3-ASR-0.6B on clips with known text.

Clips are the V0-4 sentences (known text) with 1.5 s of silence appended, streamed in 30 ms frames
as a microphone would deliver them. Never records from the microphone.
"""

import json
import re
import time
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf
from mlx_audio.realtime_vad import ServerVadConfig, StreamingVad, TurnEventKind
from mlx_audio.resample import resample_audio_array
from mlx_audio.stt import load as load_stt
from mlx_audio.vad.utils import load as load_vad

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CLIPS = HERE.parent / "v04-tts" / "out"
ASR = "mlx-community/Qwen3-ASR-0.6B-8bit"
VAD = "mlx-community/silero-vad"
SR = 16000
FRAME = 480
TAIL_S = 1.5
PARTIAL_EVERY_S = 0.5
PREFIX_S = 0.3
SILENCE_MS = (300, 500, 800)
LANG_NAMES = {"zh": "chinese", "en": "english", "ja": "japanese"}


def normalise(text: str, lang: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[^\w ]", "", text) if lang == "en" else re.sub(r"[^\w]", "", text)


def edit_distance(a: list, b: list) -> int:
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[len(b)]


def error_rate(ref: str, hyp: str, lang: str) -> float:
    ref, hyp = normalise(ref, lang), normalise(hyp, lang)
    if lang == "en":
        return round(edit_distance(ref.split(), hyp.split()) / len(ref.split()), 3)
    return round(edit_distance(list(ref), list(hyp)) / len(ref), 3)


def speech_end_s(audio: np.ndarray) -> float:
    hop = SR // 100
    frames = len(audio) // hop
    rms = np.sqrt(np.mean(audio[: frames * hop].reshape(frames, hop) ** 2, axis=1))
    voiced = np.nonzero(rms > 0.05 * rms.max())[0]
    return (voiced[-1] + 1) * hop / SR


def load_clip(wav: Path) -> np.ndarray:
    audio, rate = sf.read(wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return resample_audio_array(audio, rate, SR)


def transcribe(asr, audio: np.ndarray) -> tuple[object, float]:
    started = time.perf_counter()
    result = asr.generate(audio)
    return result, time.perf_counter() - started


def run_clip(asr, vad_model, audio: np.ndarray, silence_ms: int) -> dict:
    padded = np.concatenate([audio, np.zeros(int(TAIL_S * SR), dtype=np.float32)])
    vad = StreamingVad(vad_model, ServerVadConfig(threshold=0.5, prefix_padding_ms=300, silence_duration_ms=silence_ms))
    turns: list[list[float]] = []
    partial_ms = []
    next_partial = PARTIAL_EVERY_S
    vad_compute = 0.0
    fed = 0
    # Listen through the whole clip: a pause between sentences can end a turn early, and the
    # utterance only really ends at the last stop.
    while fed < len(padded):
        chunk = padded[fed : fed + FRAME]
        tick = time.perf_counter()
        events = vad.process(chunk)
        vad_compute += time.perf_counter() - tick
        fed += len(chunk)
        now = fed / SR
        for event in events:
            if event.kind == TurnEventKind.SPEECH_STARTED:
                turns.append([now, None])
            elif event.kind == TurnEventKind.SPEECH_STOPPED and turns:
                turns[-1][1] = now
        if turns and turns[-1][1] is None and now - turns[0][0] >= next_partial:
            _, seconds = transcribe(asr, padded[max(0, int((turns[0][0] - PREFIX_S) * SR)) : fed])
            partial_ms.append(round(seconds * 1000))
            next_partial += PARTIAL_EVERY_S
    if not turns or turns[-1][1] is None:
        return {"error": "vad never closed the utterance", "turns": len(turns)}
    first_start, final_stop = turns[0][0], turns[-1][1]
    utterance = padded[max(0, int((first_start - PREFIX_S) * SR)) : int(final_stop * SR)]
    result, decode_s = transcribe(asr, utterance)
    wait_ms = round((final_stop - speech_end_s(audio)) * 1000)
    return {
        "turns": len(turns),
        "text": result.text,
        "endpoint_wait_ms": wait_ms,
        "decode_ms": round(decode_s * 1000),
        "speech_end_to_text_ms": wait_ms + round(decode_s * 1000),
        "partials": len(partial_ms),
        "partial_decode_ms_max": max(partial_ms, default=0),
        "vad_compute_x_realtime": round((fed / SR) / max(vad_compute, 1e-9), 1),
    }


def false_triggers(vad_model) -> int:
    rng = np.random.default_rng(7)
    white = rng.standard_normal(10 * SR).astype(np.float32)
    spectrum = np.fft.rfft(white) / np.sqrt(np.arange(1, 10 * SR // 2 + 2))
    pink = np.fft.irfft(spectrum, n=10 * SR).astype(np.float32)
    pink *= 10 ** (-50 / 20) / np.sqrt(np.mean(pink**2))
    vad = StreamingVad(vad_model, ServerVadConfig())
    events = []
    for i in range(0, len(pink), FRAME):
        events += vad.process(pink[i : i + FRAME])
    return sum(e.kind == TurnEventKind.SPEECH_STARTED for e in events)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    asr = load_stt(ASR)
    vad_model = load_vad(VAD)
    transcribe(asr, np.zeros(SR, dtype=np.float32))
    report = {"clips": {}, "false_triggers_10s_pink_-50dBFS": false_triggers(vad_model)}
    for wav in sorted(CLIPS.glob("??-?.wav")):
        lang = wav.stem[:2]
        text = wav.with_suffix(".txt").read_text()
        audio = load_clip(wav)
        ptt, ptt_s = transcribe(asr, audio[: int(speech_end_s(audio) * SR)])
        language = ptt.language[0] if isinstance(ptt.language, list) else ptt.language
        entry = {
            "push_to_talk": {
                "text": ptt.text,
                "error_rate": error_rate(text, ptt.text, lang),
                "language": language,
                "language_ok": (language or "").lower().startswith(LANG_NAMES[lang]),
                "decode_ms": round(ptt_s * 1000),
            }
        }
        for silence_ms in SILENCE_MS:
            run = run_clip(asr, vad_model, audio, silence_ms)
            if "text" in run:
                run["error_rate"] = error_rate(text, run["text"], lang)
            entry[f"vad_{silence_ms}ms"] = run
        report["clips"][wav.stem] = entry
        print(wav.stem, json.dumps(entry, ensure_ascii=False), flush=True)
    (OUT / "bench.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
