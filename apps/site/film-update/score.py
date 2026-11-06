"""The update film's soundtrack: the same Apple Loops as the first film (GarageBand's Disco Funk pack,
"Glitter Nights"), arranged on this film's bar grid, with sound effects made here, mixed to one WAV:

    uv run --with numpy --with scipy --with soundfile python score.py cues.json assets/music.wav

Apple's GarageBand licence lets these loops be used, royalty free, in an original soundtrack for a
film; it does not allow passing the loops on by themselves. So only this arrangement and the
finished film are kept, never the loops or the mix on its own.
"""

import importlib.util
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

_spec = importlib.util.spec_from_file_location(
    "first_film_score", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "film", "score.py")
)
first = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(first)

SR, BEAT = first.SR, first.BEAT
Track, at, bars, db, loop, reverb, sweep, loudness = (
    first.Track, first.at, first.bars, first.db, first.loop, first.reverb, first.sweep, first.loudness,
)


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
        "guitar3": loop("Glitter Nights Funk Guitar 03"),
        "swell": loop("Glitter Nights Synth Swell 01"),
        "riser": loop("80s Synth FX Riser 01"),
        "fall": loop("Wipeout Synth FX 04"),
    }
    T = {k: Track(length) for k in ("drums", "hat", "bass", "keys", "guitar", "fx", "end")}

    # Bars 1-4, the groove from the first frame, through a filter that opens in the first half bar: the
    # opening shows something new at once, so the music has no slow intro either. Chords vamp on D; the
    # guitar joins at bar 2.
    T["drums"].repeat(L["beat"], 0, bars(4))
    T["hat"].repeat(L["hat"], 0, bars(4), db(-4))
    T["bass"].repeat(L["funk_bass"], 0, bars(4), db(-1))
    T["keys"].repeat(L["chords"], 0, bars(4), db(-5))
    T["guitar"].repeat(L["guitar"], bars(1), bars(4), db(-4))
    # Bar 5, the build under the live picture: the beat thins under a rising high-pass, the synth bass
    # walks up, the riser.
    T["drums"].repeat(L["beat"], bars(4), bars(5))
    T["hat"].repeat(L["hat"], bars(4), bars(5), db(-2))
    T["bass"].repeat(L["synth_bass"], bars(4), bars(5), db(1), phase=bars(2))
    T["keys"].repeat(L["swell"], bars(4), bars(5), db(-4))
    T["fx"].put(L["riser"], bars(4), db(-5), offset=bars(1))
    # Bars 6-9, the chorus: it comes in with the preview card, with everything.
    T["drums"].repeat(L["beat"], bars(5), bars(9))
    T["hat"].repeat(L["hat"], bars(5), bars(9), db(-3))
    T["bass"].repeat(L["synth_bass"], bars(5), bars(9), db(1))
    T["keys"].repeat(L["pad"], bars(5), bars(9), db(-1))
    T["keys"].repeat(L["chords"], bars(5), bars(9), db(-6))
    T["guitar"].repeat(L["guitar3"], bars(5), bars(9), db(-3))
    T["fx"].put(L["fall"], bars(5), db(-10))
    # Bar 10, the lift into the end: the pad and the bass, the hats further back, the riser.
    T["keys"].repeat(L["pad"], bars(9), bars(10), db(-2), phase=bars(2))
    T["bass"].repeat(L["synth_bass"], bars(9), bars(10), db(-3))
    T["hat"].repeat(L["hat"], bars(9), bars(10), db(-8))
    T["fx"].put(L["riser"], bars(9), db(-8), offset=bars(1))
    # The last hit on the first beat of bar 11, and the pad rings out.
    hit = np.zeros((BEAT, 2))
    hit += L["beat"][:BEAT] + db(1) * L["synth_bass"][:BEAT] + db(-4) * L["chords"][:BEAT]
    hit *= np.linspace(1, 0, BEAT)[:, None] ** 0.6
    T["end"].put(hit, bars(10))
    T["end"].put(L["pad"][: bars(2)] * np.linspace(1, 0, bars(2))[:, None] ** 1.5, bars(10), db(-2))

    # Automation.
    opening = slice(0, bars(1))
    heard = sum(T[k].buf[opening] for k in ("drums", "hat", "bass", "keys"))
    for k in ("drums", "bass", "keys"):
        T[k].buf[opening] = 0
    T["hat"].buf[opening] = sweep(heard, "low", [(0, 900), (0.5, 6000), (1.0, 18000)])
    build = slice(bars(4), bars(5))
    T["drums"].buf[build] = sweep(T["drums"].buf[build], "high", [(0, 30), (1.6, 900), (2.0, 1400)])

    mix = sum(t.buf for t in T.values())
    end = T["end"].buf
    mix = mix - end + reverb(end, 0.35)[: len(mix)]

    # Sound effects on the picture's cues.
    sfx = Track(length)
    for cue in cues["sounds"]:
        x = first.SOUNDS[cue["sound"]]()
        sfx.put(x, at(cue["at"]), db(cue.get("db", -14)))
    sfx.buf = reverb(sfx.buf, 0.18, 1.2)[: length]
    mix += sfx.buf

    # The shape of the whole: a quiet open, the groove under the phone, the chorus full, the breakdown low.
    contour = [(0, -1.5), (7.9, -1.5), (8.0, -3), (9.9, -0.5), (10.0, 0), (17.9, 0), (18.0, -2.5),
               (19.9, -1.5), (20.0, 0)]
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


if __name__ == "__main__":
    main()
