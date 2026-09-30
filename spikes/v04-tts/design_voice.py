"""Step 1: design three original voices from text descriptions; the first becomes out/ref.wav."""

import json
import shutil
import time

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

from common import LANG, OUT, REF_LANG, REF_TEXT, TTS_DESIGN, VOICE_DESIGNS


def main() -> None:
    OUT.mkdir(exist_ok=True)
    model = load_model(TTS_DESIGN)
    report = {}
    for name, description in VOICE_DESIGNS.items():
        started = time.perf_counter()
        results = list(model.generate_voice_design(text=REF_TEXT, language=LANG[REF_LANG], instruct=description))
        audio = np.concatenate([np.array(r.audio) for r in results])
        sample_rate = results[-1].sample_rate
        sf.write(OUT / f"ref-{name}.wav", audio, sample_rate)
        report[name] = {
            "description": description,
            "audio_s": round(len(audio) / sample_rate, 2),
            "wall_s": round(time.perf_counter() - started, 2),
        }
        print(name, report[name], flush=True)
    (OUT / "ref.txt").write_text(REF_TEXT)
    shutil.copy(OUT / "ref-a.wav", OUT / "ref.wav")
    report["peak_mem_gb"] = round(mx.get_peak_memory() / 1e9, 2)
    (OUT / "design.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
