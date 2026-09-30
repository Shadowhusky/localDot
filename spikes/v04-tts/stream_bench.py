"""Step 2: speak two sentences per language in the designed voice, streamed, and time it."""

import json
import sys
import time

import mlx.core as mx
import numpy as np
import psutil
import soundfile as sf
from huggingface_hub import snapshot_download
from mlx_audio.tts.utils import load_model

from common import LANG, OUT, SENTENCES, TTS_BASE

STREAM_INTERVAL_S = 0.32


def speak(model, text: str, lang: str, ref: str, ref_text: str) -> tuple[np.ndarray, int, float, float]:
    started = time.perf_counter()
    first = None
    chunks = []
    sample_rate = 24000
    for r in model.generate(
        text=text, ref_audio=ref, ref_text=ref_text, lang_code=LANG[lang], stream=True, streaming_interval=STREAM_INTERVAL_S
    ):
        if first is None:
            first = time.perf_counter() - started
        chunks.append(np.array(r.audio))
        sample_rate = r.sample_rate
    return np.concatenate(chunks), sample_rate, first or 0.0, time.perf_counter() - started


def main() -> None:
    ref = str(OUT / (sys.argv[1] if len(sys.argv) > 1 else "ref.wav"))
    ref_text = (OUT / "ref.txt").read_text()
    process = psutil.Process()
    loaded = time.perf_counter()
    model = load_model(snapshot_download(TTS_BASE))
    load_s = time.perf_counter() - loaded
    speak(model, "Hi.", "en", ref, ref_text)
    report = {"load_s": round(load_s, 2), "sentences": {}}
    peak_rss = 0
    for lang, sentences in SENTENCES.items():
        for n, text in enumerate(sentences, 1):
            audio, sample_rate, ttfa, wall = speak(model, text, lang, ref, ref_text)
            peak_rss = max(peak_rss, process.memory_info().rss)
            tag = f"{lang}-{n}"
            sf.write(OUT / f"{tag}.wav", audio, sample_rate)
            (OUT / f"{tag}.txt").write_text(text)
            duration = len(audio) / sample_rate
            report["sentences"][tag] = {
                "audio_s": round(duration, 2),
                "first_audio_ms": round(ttfa * 1000),
                "wall_s": round(wall, 2),
                "realtime_x": round(duration / wall, 2),
            }
            print(tag, report["sentences"][tag], flush=True)
    firsts = [s["first_audio_ms"] for s in report["sentences"].values()]
    report["first_audio_ms_max"] = max(firsts)
    report["first_audio_ms_median"] = sorted(firsts)[len(firsts) // 2]
    report["peak_mlx_gb"] = round(mx.get_peak_memory() / 1e9, 2)
    report["peak_rss_gb"] = round(peak_rss / 1e9, 2)
    (OUT / "stream.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "sentences"}))


if __name__ == "__main__":
    main()
