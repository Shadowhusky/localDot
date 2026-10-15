"""The film's soundtrack: Apple Loops from GarageBand's Disco Funk pack, arranged on the film's bar
grid, with sound effects made here, mixed to one WAV. film/assets.mjs runs it:

    uv run --with numpy --with scipy --with soundfile python score.py cues.json assets/music.wav

Apple's GarageBand licence lets these loops be used, royalty free, in an original soundtrack for a
film; it does not allow passing the loops on by themselves. So only this arrangement and the
finished film are kept, never the loops or the mix on its own.
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf
from scipy import signal

SR = 48000
BPM = 120
BEAT = SR * 60 // BPM
BAR = 4 * BEAT
LIBRARY = "/Library/Audio/Apple Loops/Apple/09 Disco Funk"
CACHE = os.path.join(tempfile.gettempdir(), "localdot-film-loops")


def bars(n: float) -> int:
    return int(round(n * BAR))


def at(seconds: float) -> int:
    return int(round(seconds * SR))


def db(v: float) -> float:
    return 10 ** (v / 20)


def loop(name: str) -> np.ndarray:
    """A loop decoded by Apple's own converter, which honours the AAC priming, so it is
    sample-exact on the grid."""
    os.makedirs(CACHE, exist_ok=True)
    wav = os.path.join(CACHE, name.replace(" ", "_") + ".wav")
    if not os.path.exists(wav):
        src = os.path.join(LIBRARY, name + ".caf")
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEF32@48000", src, wav], check=True)
    x, sr = sf.read(wav, dtype="float32", always_2d=True)
    assert sr == SR, (name, sr)
    return x


class Track:
    def __init__(self, length: int):
        self.buf = np.zeros((length, 2), dtype=np.float64)

    def put(self, clip: np.ndarray, start: int, gain: float = 1.0, offset: int = 0, length: int | None = None):
        clip = clip[offset:]
        if length is not None:
            clip = clip[:length]
        end = min(len(self.buf), start + len(clip))
        if end > start:
            self.buf[start:end] += clip[: end - start] * gain

    def repeat(self, clip: np.ndarray, start: int, end: int, gain: float = 1.0, phase: int = 0):
        """Loops `clip` from `start` to `end`, `phase` samples into it at `start`."""
        pos, off = start, phase % len(clip)
        while pos < end:
            n = min(len(clip) - off, end - pos)
            self.put(clip, pos, gain, off, n)
            pos += n
            off = 0


def sweep(x: np.ndarray, kind: str, points: list[tuple[float, float]], q: float = 0.8, block: int = 256) -> np.ndarray:
    """A low- or high-pass whose cutoff (Hz) moves through `points` in film seconds."""
    y = np.zeros_like(x)
    zi = np.zeros((2, 2))
    t = (np.arange(0, len(x), block) + block / 2) / SR
    cut = np.exp(np.interp(t, [p[0] for p in points], np.log([p[1] for p in points])))
    for i, f in enumerate(cut):
        s = i * block
        w = 2 * np.pi * min(f, SR * 0.45) / SR
        alpha = np.sin(w) / (2 * q)
        c = np.cos(w)
        if kind == "low":
            b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2])
        else:
            b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2])
        a = np.array([1 + alpha, -2 * c, 1 - alpha])
        b, a = b / a[0], a / a[0]
        for ch in range(2):
            y[s : s + block, ch], zi[ch] = signal.lfilter(b, a, x[s : s + block, ch], zi=zi[ch])
    return y


def room(seconds: float = 2.4, seed: int = 7) -> np.ndarray:
    """A soft, dark stereo room: decaying noise, low-passed."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    decay = np.exp(-t * 6.9 / seconds)
    ir = rng.standard_normal((n, 2)) * decay[:, None]
    b, a = signal.butter(2, 5000 / (SR / 2))
    ir = signal.lfilter(b, a, ir, axis=0)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt((ir**2).sum(axis=0).mean())


def reverb(x: np.ndarray, wet: float, seconds: float = 2.4) -> np.ndarray:
    ir = room(seconds)
    out = np.stack([signal.fftconvolve(x[:, c], ir[:, c]) for c in range(2)], axis=1)
    pad = np.zeros((len(out), 2))
    pad[: len(x)] = x
    return pad + wet * out


# Sound effects, made from sine waves and noise so they are ours.


def tone(freq: float, seconds: float, attack: float = 0.004, decay: float = 0.25) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    env = np.minimum(1, t / attack) * np.exp(-t / decay)
    return np.sin(2 * np.pi * freq * t) * env


def pop() -> np.ndarray:
    """dot landing: a bubbly blip falling in pitch, over a soft thump."""
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    f = 180 + 520 * np.exp(-t / 0.03)
    blip = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, t / 0.002) * np.exp(-t / 0.05)
    thump = np.sin(2 * np.pi * 62 * t) * np.minimum(1, t / 0.003) * np.exp(-t / 0.07)
    x = 0.6 * blip + 0.8 * thump
    return np.stack([x, x], axis=1)


def whoosh(seconds: float = 0.6, up: bool = True, seed: int = 3) -> np.ndarray:
    """Air past the camera: noise through a band-pass that sweeps."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    noise = rng.standard_normal((n, 2))
    lo, hi = (400, 4200) if up else (4200, 400)
    out = sweep(noise, "high", [(0, lo * 0.5), (seconds, hi * 0.5)], q=0.7)
    out = sweep(out, "low", [(0, lo * 2), (seconds, hi * 2)], q=0.7)
    t = np.linspace(0, 1, n)
    env = np.sin(np.pi * t) ** 2
    return out * env[:, None] / (np.abs(out).max() + 1e-9)


def click() -> np.ndarray:
    """A UI press: a tiny tick and a short high ping."""
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(11)
    tick = rng.standard_normal(n) * np.exp(-t / 0.002)
    ping = np.sin(2 * np.pi * 3400 * t) * np.exp(-t / 0.012)
    x = 0.5 * tick + 0.5 * ping
    return np.stack([x, x * 0.95], axis=1)


def shimmer(seed: int = 5, root: float = 1174.66) -> np.ndarray:
    """An outfit change: quick rising sparkles on the notes of D major, in the track's key."""
    rng = np.random.default_rng(seed)
    steps = [0, 4, 7, 12, 16, 19, 24]
    out = np.zeros((int(0.6 * SR), 2))
    for i, s in enumerate(steps):
        f = root * 2 ** (s / 12)
        x = tone(f, 0.35, attack=0.002, decay=0.08) * 0.5
        start = int(i * 0.028 * SR)
        pan = 0.5 + 0.35 * np.sin(i * 1.7 + rng.random())
        end = min(len(out), start + len(x))
        out[start:end, 0] += x[: end - start] * (1 - pan)
        out[start:end, 1] += x[: end - start] * pan
    return out


def shutter() -> np.ndarray:
    """Saved: a soft camera shutter, two quick clicks."""
    a = click()
    out = np.zeros((int(0.2 * SR), 2))
    out[: len(a)] += a
    out[int(0.07 * SR) : int(0.07 * SR) + len(a)] += 0.7 * a
    return out


def bell(freq: float = 587.33, seconds: float = 2.5) -> np.ndarray:
    """The last note: a round FM bell on D."""
    t = np.arange(int(seconds * SR)) / SR
    mod = 1.4 * np.exp(-t / 0.5) * np.sin(2 * np.pi * freq * 3.5 * t)
    x = np.sin(2 * np.pi * freq * t + mod) * np.minimum(1, t / 0.003) * np.exp(-t / 0.9)
    return np.stack([x, x], axis=1)


SOUNDS = {
    "pop": pop,
    "whoosh": lambda: whoosh(0.6, True),
    "whoosh-down": lambda: whoosh(0.5, False, seed=4),
    "click": click,
    "shimmer": shimmer,
    "shutter": shutter,
    "bell": bell,
}


def score(cues: dict) -> np.ndarray:
    length = at(cues["length"])
    L = {
        "beat": loop("Glitter Nights Beat"),
        "hat": loop("Glitter Nights Hi-Hat Topper"),
        "funk_bass": loop("Glitter Nights Funk Bass 02"),
        "synth_bass": loop("Glitter Nights Synth Bass 02"),
        "chords": loop("Glitter Nights Synth Chords 01"),
        "pad": loop("Glitter Nights Synth Pad"),
        "guitar": loop("Glitter Nights Funk Guitar 02"),
        "swell": loop("Glitter Nights Synth Swell 01"),
        "riser": loop("80s Synth FX Riser 01"),
        "fall": loop("Wipeout Synth FX 04"),
    }
    T = {k: Track(length) for k in ("drums", "hat", "bass", "keys", "guitar", "fx", "end")}

    # Bar 1, the cold open: the groove from the first frame through a closed filter that opens on
    # the drop, under the last half of a riser.
    T["drums"].repeat(L["beat"], 0, bars(7))
    T["hat"].repeat(L["hat"], 0, bars(7), db(-4))
    T["bass"].repeat(L["funk_bass"], 0, bars(7), db(-1))
    T["keys"].repeat(L["swell"], 0, bars(1), db(-3))
    T["fx"].put(L["riser"], 0, db(-7), offset=bars(1))
    # Bars 2-7, the groove: the beat, the funk bass and the chords vamp on D; the guitar joins for
    # the montage.
    T["keys"].repeat(L["chords"], bars(1), bars(7), db(-5))
    T["guitar"].repeat(L["guitar"], bars(2), bars(7), db(-4))
    T["fx"].put(L["fall"], bars(1), db(-12))
    # Bars 8-9, the build: the beat thins under a rising high-pass, the synth bass walks up, the
    # riser again.
    T["drums"].repeat(L["beat"], bars(7), bars(9))
    T["hat"].repeat(L["hat"], bars(7), bars(9), db(-2))
    T["bass"].repeat(L["synth_bass"], bars(7), bars(9), db(1), phase=bars(2))
    T["keys"].repeat(L["swell"], bars(7), bars(9), db(-4))
    T["fx"].put(L["riser"], bars(7), db(-5))
    # Bars 10-16, the chorus: everything. The last beat of bar 13 is the rewind.
    T["drums"].repeat(L["beat"], bars(9), bars(16))
    T["hat"].repeat(L["hat"], bars(9), bars(16), db(-3))
    T["bass"].repeat(L["synth_bass"], bars(9), bars(16), db(1))
    T["keys"].repeat(L["pad"], bars(9), bars(16), db(-1))
    T["keys"].repeat(L["chords"], bars(9), bars(16), db(-6))
    T["guitar"].repeat(L["guitar"], bars(9), bars(16), db(-3))
    T["fx"].put(L["fall"], bars(9), db(-10))
    # Bar 17, the breakdown: the pad and the bass alone, the hats far back.
    T["keys"].repeat(L["pad"], bars(16), bars(17), db(-1), phase=bars(2))
    T["bass"].repeat(L["synth_bass"], bars(16), bars(17), db(-2))
    T["hat"].repeat(L["hat"], bars(16) + 2 * BEAT, bars(17), db(-9))
    # The last hit on the first beat of bar 18, and the pad rings out.
    hit = np.zeros((BEAT, 2))
    hit += L["beat"][:BEAT] + db(1) * L["synth_bass"][:BEAT] + db(-4) * L["chords"][:BEAT]
    hit *= np.linspace(1, 0, BEAT)[:, None] ** 0.6
    T["end"].put(hit, bars(17))
    T["end"].put(L["pad"][: bars(2)] * np.linspace(1, 0, bars(2))[:, None] ** 1.5, bars(17), db(-2))

    # Automation.
    cold = slice(0, bars(1))
    intro = sum(T[k].buf[cold] for k in ("drums", "hat", "bass", "keys"))
    for k in ("drums", "bass", "keys"):
        T[k].buf[cold] = 0
    T["hat"].buf[cold] = sweep(intro, "low", [(0, 320), (1.7, 2800), (2.0, 18000)])
    build = slice(bars(7), bars(9))
    T["drums"].buf[build] = sweep(T["drums"].buf[build], "high", [(0, 30), (3.6, 900), (4.0, 1400)])

    mix = sum(t.buf for t in T.values())
    end = T["end"].buf
    mix = mix - end + reverb(end, 0.35)[: len(mix)]

    # The rewind: the beat before bar 14 plays the two beats before it backwards, twice as fast.
    r0, r1 = bars(12) + 3 * BEAT, bars(13)
    back = mix[r0 - 2 * BEAT : r0][::-1]
    back = signal.resample(back, BEAT, axis=0)
    edge = int(0.012 * SR)
    shape = np.linspace(0.5, 1, BEAT)
    shape[:edge] *= np.linspace(0, 1, edge)
    shape[-edge:] *= np.linspace(1, 0, edge)
    keep = np.zeros(BEAT)
    keep[:edge] = np.linspace(1, 0, edge)
    mix[r0:r1] = back * shape[:, None] + mix[r0:r1] * keep[:, None]

    # Sound effects on the picture's cues.
    sfx = Track(length)
    for cue in cues["sounds"]:
        x = SOUNDS[cue["sound"]]()
        sfx.put(x, at(cue["at"]), db(cue.get("db", -14)))
    sfx.buf = reverb(sfx.buf, 0.18, 1.2)[: length]
    mix += sfx.buf

    # The shape of the whole: a quiet open, the groove under the chorus, the breakdown low.
    contour = [(0, -3), (1.9, -2), (2.0, -1.5), (13.9, -1.5), (14.0, -3), (17.9, -0.5), (18.0, 0),
               (31.9, 0), (32.0, -3.5), (33.9, -2.5), (34.0, 0)]
    t = np.arange(length) / SR
    mix = mix * db(np.interp(t, [c[0] for c in contour], [c[1] for c in contour]))[:, None]

    fade = np.ones(length)
    tail = at(cues["length"] - 1.2)
    fade[tail:] = np.linspace(1, 0, length - tail) ** 2
    return mix * fade[:, None]


def main():
    cues = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    mix = score(cues)
    raw = out + ".raw.wav"
    glued = out + ".glued.wav"
    sf.write(raw, mix.astype(np.float32), SR, subtype="FLOAT")
    # Glue with a gentle bus compressor, then one static gain to -14 LUFS, so the sections keep
    # their shape, and a limiter to keep peaks under -1 dBTP.
    ffmpeg = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run(
        ffmpeg + ["-i", raw, "-af", "acompressor=threshold=-20dB:ratio=1.8:attack=25:release=200", "-c:a", "pcm_f32le", glued],
        check=True,
    )
    gain = -14 - loudness(glued)
    limit = "alimiter=limit=0.8:attack=2:release=80:level=false"
    subprocess.run(ffmpeg + ["-i", glued, "-af", f"volume={gain:.2f}dB,{limit}", "-c:a", "pcm_s24le", out], check=True)
    os.remove(raw)
    os.remove(glued)
    print(f"{out}: {loudness(out):.1f} LUFS")


def loudness(path: str) -> float:
    report = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True
    ).stderr
    line = [l for l in report.splitlines() if l.strip().startswith("I:")][-1]
    return float(line.split()[1])


if __name__ == "__main__":
    main()
