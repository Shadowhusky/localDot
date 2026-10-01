"""Forced-aligner units to A/I/U/E/O/N/rest mouth shapes, as proven in the V0-4 spike."""

import re
from dataclasses import dataclass
from functools import cache

import cmudict
from pypinyin import Style, pinyin

GAP_REST_MS = 120
EMPTY_UNIT_MORA_MS = 60
LAST_UNIT_TAIL_S = 0.3

KANA = re.compile(r"[\U00003040-\U000030ff\U000031f0-\U000031ff]")
HAN = re.compile(r"[\U00003400-\U00004dbf\U00004e00-\U00009fff\U0000f900-\U0000faff]")
LATIN = re.compile(r"[A-Za-z]")

ARPABET = {
    "AA": "A", "AE": "A", "AH": "A", "AY": "A", "AW": "A",
    "EH": "E", "EY": "E", "ER": "E",
    "IH": "I", "IY": "I",
    "AO": "O", "OW": "O", "OY": "O",
    "UH": "U", "UW": "U",
}
CLOSED_ONSETS = {"M", "B", "P"}
# Pinyin abbreviates uei → ui and iou → iu; the hidden vowel is the one the mouth shows.
PINYIN_ABBREVIATED = {"ui": "E", "iu": "O"}
PINYIN_VOWELS = (("a", "A"), ("o", "O"), ("e", "E"), ("i", "I"), ("u", "U"), ("v", "U"))
JA_VOWELS = {"a": "A", "i": "I", "u": "U", "e": "E", "o": "O"}
LATIN_VOWELS = {"a": "A", "e": "E", "i": "I", "y": "I", "o": "O", "u": "U"}


@dataclass(frozen=True)
class Unit:
    text: str
    start: float
    end: float


@cache
def _cmu() -> dict[str, list[list[str]]]:
    return cmudict.dict()


@cache
def _openjtalk():
    # Imported on first Japanese use: the import prints a warning about an optional ONNX runtime.
    import pyopenjtalk

    return pyopenjtalk


def zh_shapes(text: str) -> list[str]:
    shapes = []
    for (final,) in pinyin(text, style=Style.FINALS, strict=False, errors="ignore"):
        if final in PINYIN_ABBREVIATED:
            shapes.append(PINYIN_ABBREVIATED[final])
            continue
        for vowel, shape in PINYIN_VOWELS:
            if vowel in final:
                shapes.append(shape)
                break
    return shapes


def ja_shapes(text: str) -> list[str]:
    shapes = []
    for phoneme in _openjtalk().g2p(text).split():
        if phoneme == "N":
            shapes.append("N")
        elif phoneme.lower() in JA_VOWELS:
            shapes.append(JA_VOWELS[phoneme.lower()])
    return shapes


def en_shapes(text: str) -> list[str]:
    word = re.sub(r"[^a-z']", "", text.lower())
    prons = _cmu().get(word)
    if not prons:
        return [LATIN_VOWELS[group[0]] for group in re.findall(r"[aeiouy]+", word)]
    phones = [p.rstrip("012") for p in prons[0]]
    shapes = ["N"] if phones and phones[0] in CLOSED_ONSETS else []
    return shapes + [ARPABET[p] for p in phones if p in ARPABET]


def shapes_for(text: str, lang: str) -> list[str]:
    """A unit's shapes by its own script, so an English word inside a Chinese sentence reads as English."""
    if KANA.search(text):
        return ja_shapes(text)
    if HAN.search(text):
        return ja_shapes(text) if lang == "ja" else zh_shapes(text)
    if LATIN.search(text):
        return en_shapes(text)
    return []


def build_track(units: list[Unit], lang: str) -> list[dict]:
    visemes: list[dict] = []
    for k, unit in enumerate(units):
        next_start = units[k + 1].start if k + 1 < len(units) else unit.end + LAST_UNIT_TAIL_S
        shapes = shapes_for(unit.text, lang) or ["A"]
        span = unit.end - unit.start
        if span <= 0:
            span = min(len(shapes) * EMPTY_UNIT_MORA_MS / 1000, max(next_start - unit.start, 0.04))
        step = span / len(shapes)
        for i, shape in enumerate(shapes):
            visemes.append({"t": round((unit.start + i * step) * 1000), "shape": shape})
        if next_start - (unit.start + span) >= GAP_REST_MS / 1000:
            visemes.append({"t": round((unit.start + span) * 1000), "shape": "rest"})
    if not visemes:
        return []
    last_end = max(units[-1].end * 1000, visemes[-1]["t"])
    visemes.append({"t": round(last_end), "shape": "rest"})
    merged: list[dict] = []
    for v in sorted(visemes, key=lambda v: v["t"]):
        if merged and merged[-1]["t"] == v["t"]:
            merged.pop()
        if merged and merged[-1]["shape"] == v["shape"]:
            continue
        merged.append(v)
    return merged
