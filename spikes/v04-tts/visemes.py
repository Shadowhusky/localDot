"""Step 3: forced-align each sentence and map the timings to mouth shapes (A/I/U/E/O/N/rest).

Also scores each track against the audio itself: an open-mouth shape should start on voiced audio,
and a rest should sit on near-silence.
"""

import json
import re
import time

import cmudict
import numpy as np
import pyopenjtalk
import soundfile as sf
from mlx_audio.stt import load
from pypinyin import Style, pinyin

from common import ALIGNER, LANG, OUT, SENTENCES

GAP_REST_MS = 120
EMPTY_UNIT_MORA_MS = 60
ONSET_WINDOW_MS = 60
HOP_MS = 10

CMU = cmudict.dict()
ARPABET = {
    "AA": "A", "AE": "A", "AH": "A", "AY": "A", "AW": "A",
    "EH": "E", "EY": "E", "ER": "E",
    "IH": "I", "IY": "I",
    "AO": "O", "OW": "O", "OY": "O",
    "UH": "U", "UW": "U",
}
CLOSED_ONSETS = {"M", "B", "P"}
PINYIN_ABBREVIATED = {"ui": "E", "iu": "O"}
JA_VOWELS = {"a": "A", "i": "I", "u": "U", "e": "E", "o": "O", "N": "N"}


def zh_shapes(unit: str) -> list[str]:
    shapes = []
    for (final,) in pinyin(unit, style=Style.FINALS, strict=False, errors="ignore"):
        # Pinyin abbreviates uei → ui and iou → iu; the hidden vowel is the one the mouth shows.
        if final in PINYIN_ABBREVIATED:
            shapes.append(PINYIN_ABBREVIATED[final])
            continue
        for vowel, shape in (("a", "A"), ("o", "O"), ("e", "E"), ("i", "I"), ("u", "U"), ("v", "U")):
            if vowel in final:
                shapes.append(shape)
                break
    return shapes


def ja_shapes(unit: str) -> list[str]:
    phonemes = pyopenjtalk.g2p(unit).split()
    return [JA_VOWELS[p.lower() if p != "N" else p] for p in phonemes if p.lower() in "aiueo" or p == "N"]


def en_shapes(unit: str) -> list[str]:
    word = re.sub(r"[^a-z']", "", unit.lower())
    prons = CMU.get(word)
    if not prons:
        return [{"a": "A", "e": "E", "i": "I", "y": "I", "o": "O", "u": "U"}[g[0]] for g in re.findall(r"[aeiouy]+", word)]
    phones = prons[0]
    shapes = ["N"] if phones and phones[0] in CLOSED_ONSETS else []
    return shapes + [ARPABET[p.rstrip("012")] for p in phones if p.rstrip("012") in ARPABET]


SHAPERS = {"zh": zh_shapes, "ja": ja_shapes, "en": en_shapes}


def track(units: list[tuple[str, float, float]], lang: str) -> list[dict]:
    visemes: list[dict] = []
    for k, (text, start, end) in enumerate(units):
        next_start = units[k + 1][1] if k + 1 < len(units) else end + 0.3
        shapes = SHAPERS[lang](text) or ["A"]
        span = end - start
        if span <= 0:
            span = min(len(shapes) * EMPTY_UNIT_MORA_MS / 1000, max(next_start - start, 0.04))
        step = span / len(shapes)
        for i, shape in enumerate(shapes):
            visemes.append({"t": round((start + i * step) * 1000), "shape": shape})
        if next_start - (start + span) >= GAP_REST_MS / 1000:
            visemes.append({"t": round((start + span) * 1000), "shape": "rest"})
    last_end = units[-1][2] if units else 0
    visemes.append({"t": round(max(last_end, visemes[-1]["t"] / 1000 if visemes else 0) * 1000), "shape": "rest"})
    merged = []
    for v in sorted(visemes, key=lambda v: v["t"]):
        if merged and merged[-1]["t"] == v["t"]:
            merged.pop()
        if merged and merged[-1]["shape"] == v["shape"]:
            continue
        merged.append(v)
    return merged


def envelope(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    hop = int(sample_rate * HOP_MS / 1000)
    frames = len(audio) // hop
    rms = np.sqrt(np.mean(audio[: frames * hop].reshape(frames, hop) ** 2, axis=1))
    return rms / (rms.max() or 1)


def score(visemes: list[dict], env: np.ndarray) -> dict:
    voiced = env > 0.08
    onsets = [v for v in visemes if v["shape"] not in ("rest", "N")]
    hits = sum(voiced[v["t"] // HOP_MS : (v["t"] + ONSET_WINDOW_MS) // HOP_MS].any() for v in onsets)
    rest_frames = rest_silent = 0
    for a, b in zip(visemes, visemes[1:] + [{"t": len(env) * HOP_MS}]):
        if a["shape"] == "rest":
            span = voiced[a["t"] // HOP_MS : b["t"] // HOP_MS]
            rest_frames += len(span)
            rest_silent += int((~span).sum())
    return {
        "onsets_on_voiced": round(hits / max(len(onsets), 1), 3),
        "rest_on_silence": round(rest_silent / max(rest_frames, 1), 3),
        "shapes": len(visemes),
    }


def main() -> None:
    aligner = load(ALIGNER)
    report = {}
    for lang, sentences in SENTENCES.items():
        for n, text in enumerate(sentences, 1):
            tag = f"{lang}-{n}"
            wav = OUT / f"{tag}.wav"
            aligner.generate(str(wav), text=text, language=LANG[lang])
            started = time.perf_counter()
            items = aligner.generate(str(wav), text=text, language=LANG[lang])
            align_ms = (time.perf_counter() - started) * 1000
            units = [(it.text, float(it.start_time), float(it.end_time)) for it in items]
            visemes = track(units, lang)
            audio, sample_rate = sf.read(wav)
            env = envelope(audio if audio.ndim == 1 else audio.mean(axis=1), sample_rate)
            (OUT / f"{tag}.visemes.json").write_text(json.dumps(visemes))
            report[tag] = {
                "align_ms": round(align_ms),
                "units": len(units),
                "zero_length_units": sum(1 for _, s, e in units if e <= s),
                **score(visemes, env),
            }
            print(tag, report[tag], flush=True)
    (OUT / "visemes.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
