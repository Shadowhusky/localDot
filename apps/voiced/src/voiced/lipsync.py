"""Lip-sync fixtures: public sentences in the stock voice, aligned, with their loudness."""

import json
import sys
from pathlib import Path

import numpy as np

HOP_MS = 10
VOICED = 0.08
# A mouth that opens up to 100 ms ahead of the voice still reads as in sync (ITU-R BT.1359 finds video
# leading audio by about 125 ms undetectable).
ONSET_WINDOW_MS = 100

# Ordinary sentences in each language; fixtures are public, so they never use a pack voice.
SENTENCES = {
    "zh-1": ("zh", "你终于回来了。你不在的时候，我把下载文件夹整理好了。"),
    "zh-2": ("zh", "说实话，里面简直一团糟，不过这次就放过你吧。"),
    "en-1": ("en", "Hey, you're finally back. I sorted your downloads folder while you were gone."),
    "en-2": ("en", "Honestly, it was a disaster, but I'll let it slide this time."),
    "ja-1": ("ja", "やっと帰ってきたのね。あなたがいない間に、ダウンロードフォルダを整理しておいたわ。"),
    "ja-2": ("ja", "正直、ひどい有様だったけど、今回は見逃してあげる。"),
}


def rms_per_hop(audio: np.ndarray, sample_rate: int) -> list[float]:
    hop = sample_rate * HOP_MS // 1000
    frames = len(audio) // hop
    rms = np.sqrt(np.mean(np.asarray(audio[: frames * hop], dtype=np.float64).reshape(frames, hop) ** 2, axis=1))
    return [round(float(x), 4) for x in rms]


def score(visemes: list[dict], rms: list[float]) -> dict[str, float]:
    """Share of open-mouth onsets that start on voiced audio, and of rest time that is silent."""
    level = np.asarray(rms) / (max(rms) or 1.0)
    voiced = level > VOICED
    onsets = [v for v in visemes if v["shape"] not in ("rest", "N")]
    hits = sum(bool(voiced[v["t"] // HOP_MS : (v["t"] + ONSET_WINDOW_MS) // HOP_MS].any()) for v in onsets)
    rest_frames = rest_silent = 0
    for a, b in zip(visemes, visemes[1:] + [{"t": len(level) * HOP_MS}]):
        if a["shape"] == "rest":
            span = voiced[a["t"] // HOP_MS : b["t"] // HOP_MS]
            rest_frames += len(span)
            rest_silent += int((~span).sum())
    return {
        "onsets_on_voiced": hits / max(len(onsets), 1),
        "rest_on_silence": rest_silent / max(rest_frames, 1),
    }


def record(out_dir: Path) -> None:
    from voiced.align import load_aligner
    from voiced.synth import load_synthesizer
    from voiced.visemes import build_track

    synth = load_synthesizer(None)
    aligner = load_aligner()
    out_dir.mkdir(parents=True, exist_ok=True)
    for tag, (lang, text) in SENTENCES.items():
        audio = np.concatenate(list(synth.stream(text, lang)))
        visemes = build_track(aligner.align(audio, synth.sample_rate, text, lang), lang)
        fixture = {
            "lang": lang,
            "text": text,
            "sample_rate": synth.sample_rate,
            "samples": int(audio.size),
            "rms": rms_per_hop(audio, synth.sample_rate),
            "visemes": visemes,
        }
        (out_dir / f"{tag}.json").write_text(
            json.dumps(fixture, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        print(tag, {k: round(v, 3) for k, v in score(visemes, fixture["rms"]).items()}, flush=True)


if __name__ == "__main__":
    record(Path(sys.argv[1]))
