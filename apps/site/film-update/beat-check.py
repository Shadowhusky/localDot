"""Checks the three finished cuts against the beat they are heard on, and writes renders/beat-check.md:

    uv run --with numpy python beat-check.py [wide] [tall]

The grid comes from each render's own audio (spectral-flux onsets, fitted). Every visible event and
sound effect is then timed against it. How each was timed is in its row:
  H  measured in the render, a hit: the first frame that shows the change (a cut: the frame that changes
     most, right at it)
  T  measured in the render, a fade-through: when the old screen starts to go, and when the new one has
     settled, the old gone by the midpoint and the new coming in after it
  E  measured in the render, an eased change: the start of the half-cosine that best fits its progress,
     good to about two frames, since other things in the picture move too
  C  from the composition: a pure function of time, drawn on the frame it names (dots in the air, where
     no single region can isolate them)
  A  measured in the render's audio: the onset nearest the sound's cue
"""

import json
import subprocess
import sys

import numpy as np

SR = 48000
FPS = 60
HOP = 128
TOLERANCE = 1000 / FPS

cues = json.load(open("cues.json"))
M = cues["marks"]


def audio_onsets(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
    ).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    n = 1024
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::HOP] * np.hanning(n)
    spectrum = np.abs(np.fft.rfft(frames, axis=1))
    flux = np.maximum(0, np.diff(np.log1p(spectrum * 10), axis=0)).sum(axis=1)
    times = (np.arange(len(flux)) + 1) * HOP / SR + n / (2 * SR)
    floor = np.median(flux) + 1.5 * np.std(flux)
    peaks = [
        i
        for i in range(20, len(flux) - 20)
        if flux[i] > floor and flux[i] == flux[i - 20 : i + 21].max()
    ]
    return times[peaks]


def fit_grid(onsets):
    k = np.round(onsets / 0.5)
    near = np.abs(onsets - k * 0.5) < 0.05
    period, offset = np.linalg.lstsq(np.vstack([k[near], np.ones(near.sum())]).T, onsets[near], rcond=None)[0]
    return period, offset, int(near.sum()), len(onsets)


def video(path, w, h):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"],
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w)


class Measure:
    def __init__(self, frames, full_w):
        self.f = frames
        self.k = frames.shape[2] / full_w

    def crop(self, i, roi):
        x0, y0, x1, y1 = [int(v * self.k) for v in roi]
        return self.f[min(i, len(self.f) - 1), y0:y1, x0:x1].astype(np.int16)

    def on(self, t, roi):
        """A change drawn on one frame: the largest within a few frames of the mark."""
        i0 = int(t * FPS) - 4
        d = [np.abs(self.crop(i, roi) - self.crop(i - 1, roi)).mean() for i in range(i0, i0 + 9)]
        return (i0 + int(np.argmax(d))) / FPS

    def hit(self, t, roi):
        i0, i1 = int((t - 0.25) * FPS), int((t + 0.3) * FPS)
        d = np.array([np.abs(self.crop(i, roi) - self.crop(i - 1, roi)).mean() for i in range(i0, i1)])
        quiet = np.median(d[: 8])
        floor = quiet + max(0.1, 0.12 * (d.max() - quiet))
        # The largest change near the mark, and the first frame of the rise to it.
        top = int(np.argmax(d))
        first = top
        while first > 0 and d[first - 1] > floor:
            first -= 1
        return (i0 + first) / FPS

    def eased(self, t, length, roi, pad=0.05):
        """An eased change: the start of the half-cosine that best fits its progress."""
        start, stop = int((t - pad) * FPS), int((t + length + pad) * FPS)
        a, b = self.crop(start, roi), self.crop(stop, roi)
        # The picture's overall level goes as the fade; two pictures of one level are told apart pixel
        # by pixel.
        by_level = abs(b.mean() - a.mean()) > 0.8
        seen = []
        for i in range(start, stop + 1):
            c = self.crop(i, roi)
            if by_level:
                seen.append((c.mean() - a.mean()) / (b.mean() - a.mean()))
            else:
                da, db = np.abs(c - a).mean(), np.abs(c - b).mean()
                seen.append(da / max(1e-6, da + db))
        seen = np.array(seen)
        times = np.arange(start, stop + 1) / FPS
        tries = np.arange(t - 0.15, t + 0.15, 1 / 960)
        def model(s):
            return (1 - np.cos(np.pi * np.clip((times - s) / length, 0, 1))) / 2
        errors = [((model(s) - seen) ** 2).sum() for s in tries]
        return float(tries[int(np.argmin(errors))])


# Where things are in each format: left, top, right, bottom in film pixels.
ROI = {
    "wide": {
        "chat": (1075, 110, 1505, 1000),
        "chat-head": (1120, 130, 1420, 170),
        "chat-low": (1075, 760, 1505, 1000),
        "thread": (1075, 110, 1505, 820),
        "dot-choice": (1075, 740, 1505, 800),
        "side-1": (100, 285, 420, 398),
        "side-line": (100, 505, 980, 700),
        "side-one": (100, 285, 980, 400),
        "side-one-line": (100, 410, 980, 560),
        "top": (300, 30, 760, 142),
        "top-line": (300, 146, 1620, 215),
        "hello": (100, 355, 500, 520),
        "hello-line": (100, 530, 800, 610),
        "views": (560, 30, 1360, 142),
        "stack-phone": (250, 300, 610, 1020),
        "stack-desk": (730, 260, 1820, 860),
        "chat-label": (710, 890, 1200, 995),
        "studio-label": (1285, 890, 1780, 995),
        "room": (200, 215, 1720, 1060),
        "menu": (650, 300, 1300, 950),
        "menu-row": (650, 300, 1300, 950),
        "win-a": (70, 260, 930, 880),
        "win-b": (990, 260, 1850, 880),
        "name-a": (300, 905, 700, 960),
        "name-b": (1220, 905, 1620, 960),
        "end-name": (820, 410, 1500, 590),
        "end-url": (825, 610, 1300, 665),
        "end-line": (825, 675, 1700, 770),
        "room-clear": (200, 215, 1040, 1060),
        "room-stage": (560, 320, 1240, 900),
        "preview-line": (100, 505, 980, 700),
        "win-a-clear": (70, 260, 930, 880),
        "auto-dot": (1100, 340, 1480, 740),
        "all": (0, 0, 1920, 1080),
    },
    "tall": {
        "chat": (50, 510, 835, 1490),
        "chat-head": (140, 515, 700, 570),
        "chat-low": (50, 1180, 835, 1490),
        "thread": (50, 530, 800, 1280),
        "dot-choice": (50, 1040, 844, 1110),
        "side-1": (55, 205, 330, 306),
        "side-line": (55, 410, 900, 476),
        "side-one": (55, 205, 330, 306),
        "side-one-line": (55, 318, 900, 435),
        "top": (55, 205, 330, 306),
        "top-line": (55, 318, 900, 378),
        "hello": (55, 895, 660, 1040),
        "hello-line": (55, 1055, 800, 1112),
        "views": (55, 205, 860, 306),
        "stack-phone": (45, 340, 325, 930),
        "stack-desk": (70, 970, 1010, 1490),
        "chat-label": (360, 425, 900, 560),
        "studio-label": (360, 798, 830, 932),
        "room": (10, 430, 1070, 1490),
        "menu": (200, 600, 900, 1300),
        "menu-row": (200, 600, 900, 1300),
        "win-a": (50, 456, 840, 930),
        "win-b": (50, 1013, 840, 1490),
        "name-a": (35, 390, 260, 444),
        "name-b": (35, 947, 260, 1001),
        "end-name": (250, 745, 830, 915),
        "end-url": (300, 930, 780, 1000),
        "end-line": (170, 1015, 910, 1190),
        "room-clear": (860, 800, 1070, 1490),
        "room-stage": (150, 520, 900, 980),
        "preview-line": (55, 318, 900, 378),
        "win-a-clear": (50, 456, 840, 496),
        "auto-dot": (320, 700, 760, 1150),
        "all": (0, 0, 1080, 1920),
    },
}


def events():
    """What happens, when, for how long, and how it is timed: (event, how, at, length, region)."""
    rows = [
        ("dot jumps in", "C", M["land"] - 0.5, 0.5, None),
        ("dot lands", "M", M["land"], 0, "auto-dot"),
        ("Title: hello", "M", M["land"], 0.5, "side-1"),
        ("dot hops", "C", M["hop"], 0.5, None),
        ("dot to its perch", "C", M["perch"], 0.5, None),
        ("Phone fades in, below dot's way to its perch", "M", M["ask"], 0.5, "chat-low"),
        ("Title out: hello", "M", M["chat"] - 0.5, 0.5, "side-1"),
        ("Title: chat", "M", M["chat"], 0.5, "side-1"),
        ("Fingertip appears at New conversation", "C", M["compose"] - 0.5, 0.25, None),
        ("New conversation opens", "M", M["compose"], 0, "chat"),
        ("The task typed in, from the beat after the new conversation opens", "C", M["compose"] + 0.5, 0.45, None),
        ("Message sent, in the thread above the composer", "K", M["send"], 0, "thread"),
        ("Title out: chat", "M", M["choice"] - 0.5, 0.5, "side-1"),
        ("DotChoice appears; ring", "M", M["choice"], 0, "dot-choice"),
        ("Camera in on Auto's line", "C", M["choice"], 0.5, None),
        ("Title: Auto", "M", M["choice"], 0.5, "side-1"),
        ("Conversation named", "C", M["named"], 0, None),
        ("dot replies", "M", M["reply"], 0, "chat"),
        ("Its first step", "C", M["caption"], 0, None),
        ("Camera to the live picture; ring off", "C", M["watch"], 0.5, None),
        ("Title out: Auto", "M", M["watch"] - 0.5, 0.5, "side-1"),
        ("Title: Watch", "M", M["watch"], 0.5, "side-1"),
        ("Fingertip appears at the picture", "C", M["thumb"] - 0.5, 0.25, None),
        ("Tap; the picture grows into the computer's view, camera with it", "C", M["thumb"], 0.5, None),
        ("Title out: Watch", "M", M["preview"] - 0.5, 0.5, "side-1"),
        ("The computer's view shrinks into the preview card", "C", M["preview"], 0.5, None),
        ("Title: Preview", "M", M["preview"], 0.5, "side-1"),
        ("Ring on the card", "C", M["card"], 0.25, None),
        ("Fingertip appears at Open", "C", M["open"] - 0.5, 0.25, None),
        ("Tap Open; the card opens into the phone's tab; second line below", "C", M["open"], 0.5, None),
        ("Titles out", "C", M["desk"] - 0.5, 0.5, None),
        ("Over to Studio on the desk, in one move", "C", M["desk"], 0.5, None),
        ("Title: Studio, as the pan carries the phone out under it", "C", M["studio"], 0.5, None),
        ("Title out: Studio", "M", M["several"] - 0.5, 0.5, "top"),
        ("Title: Several", "M", M["several"], 0.5, "top"),
        ("Window 2 arrives; the camera starts back", "M", M["several"], 0, "all"),
        ("Windows 3 and 4 arrive", "M", M["w4"], 0, "all"),
        ("Windows 5 and 6 arrive", "M", M["w6"], 0, "all"),
        ("Windows 7, 8 and 9 arrive", "M", M["w9"], 0, "all"),
        ("Title out: Several", "M", M["away"] - 0.5, 0.5, "top"),
        ("Windows fall in; dot jumps", "C", M["away"], 0.5, None),
        ("Cut to the end: dot and name land on the last hit", "K", M["hit"], 0, "end-name"),
        ("End: address", "M", M["hit"] + 0.5, 0.5, "end-url"),
        ("End: line", "M", M["hit"] + 1, 0.5, "end-line"),
        ("Fade to black", "M", cues["length"] - 0.5, 0.5, "end-name"),
    ]
    return sorted(rows, key=lambda row: row[2])


CUTS = [
    ("16:9 English", "renders/localdot-update-1080p.mp4", "wide", 1920, 480, 270),
    ("16:9 Chinese", "renders/localdot-update-zh-1080p.mp4", "wide", 1920, 480, 270),
    ("9:16 Chinese", "renders/localdot-update-zh-vertical.mp4", "tall", 1080, 360, 640),
]


# Where the game is in play on screen: its frames change on their own clock, as play does.
PLAY = [(M["choice"], M["preview"] + 0.5), (M["open"], M["desk"] + 0.5), (M["desk"], M["hit"])]


def stillness(path, until):
    """The longest run of frames before `until` in which under 0.5% of the picture changes at all, and
    every run longer than 0.15 s of frames under 55% as bright as the brightest within a second of them."""
    w, h = 960, 540
    pipe = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE,
    )
    last, i, run, longest, at, light = None, 0, 0, 0, 0.0, []
    while True:
        raw = pipe.stdout.read(w * h)
        if len(raw) < w * h:
            break
        frame = np.frombuffer(raw, dtype=np.uint8)
        light.append(frame.mean())
        if last is not None and i < until * FPS:
            changed = (frame != last).mean()
            run = run + 1 if changed < 0.005 else 0
            if run > longest:
                longest, at = run, (i - run + 1) / FPS
        last, i = frame, i + 1
    pipe.wait()
    light = np.array(light)
    dark = [light[i] < 0.55 * light[max(0, i - FPS) : i + FPS + 1].max() for i in range(len(light))]
    dips, start = [], None
    for i, low in enumerate(dark + [False]):
        if low and start is None:
            start = i
        if not low and start is not None:
            # The fade to black at the very end is the end, not a dip.
            if (i - start) / FPS > 0.15 and i < len(light) - 1:
                dips.append((start / FPS, (i - start) / FPS))
            start = None
    return longest / FPS, at, dips


def spikes(frames, rows):
    d = np.abs(frames[1:].astype(np.int16) - frames[:-1].astype(np.int16)).mean(axis=(1, 2))
    out = []
    for i in range(len(d)):
        near = d[max(0, i - 15) : i + 16]
        if d[i] > max(1.0, np.median(near) * 2.2) and d[i] == d[max(0, i - 3) : i + 4].max():
            t = (i + 1) / FPS
            at = [r[0] for r in rows if r[2] - 0.05 <= t <= r[2] + max(r[3], 0.25) + 0.05]
            at += ["the game in play, or the windows at work"] if any(a <= t <= b for a, b in PLAY) and not at else []
            out.append((t, float(d[i]), at))
    return out


def main():
    wanted = sys.argv[1:]
    lines = [
        "# Beat check",
        "",
        "Offsets are from the nearest beat of the grid measured in that cut's own audio. How: H a hit, its "
        "first changed frame in the render. E an eased change, the start of the half-cosine that best fits "
        "it in the render, good to about two frames because other things in the picture move too; every "
        "eased change is scheduled exactly on a beat; where a spotlight or the camera changes at the same moment as a screen, the render can't time them apart, so those rows are C. T a fade-through, measured the same way at each end: "
        "the old screen starts to go on a beat and the new one has settled on the next. C from the composition, a pure function of time "
        f"drawn on that frame. A measured in the audio. Tolerance: one frame, {TOLERANCE:.1f} ms.",
        "",
    ]
    summary = []
    summary_still = []
    for name, path, fmt, full_w, w, h in CUTS:
        if wanted and fmt not in wanted:
            continue
        onsets = audio_onsets(path)
        period, offset, matched, total = fit_grid(onsets)
        frames = video(path, w, h)
        measure = Measure(frames, full_w)
        table = []
        beat = lambda t: offset + round((t - offset) / period) * period
        rows = events()
        for event, how, at, length, region in rows:
            t = at
            if how == "T":
                roi = ROI[fmt][region]
                table.append((f"{event}: starts", "T", measure.eased(at, 0.25, roi, 0.0)))
                table.append((f"{event}: settled", "T", measure.eased(at + 0.25, 0.25, roi, 0.0) + 0.25))
                continue
            if how == "S":
                table.append((event, "E", measure.eased(at, length, ROI[fmt][region]) + length))
                continue
            if how == "E":
                table.append((event, "E", measure.eased(at, length, ROI[fmt][region])))
                continue
            if how == "E0":
                table.append((event, "E", measure.eased(at, length, ROI[fmt][region], 0.0)))
                continue
            if how == "K":
                table.append((event, "H", measure.on(at, ROI[fmt][region])))
                continue
            if how == "M":
                roi = ROI[fmt][region]
                how = "E" if length else "H"
                if region in ("auto-dot", "menu-row", "dot-choice"):
                    t = measure.on(at, roi)
                else:
                    t = measure.eased(at, length, roi) if length else measure.hit(at, roi)
            table.append((event, how, t))
        for cue in cues["sounds"]:
            near = onsets[np.argmin(np.abs(onsets - cue["at"]))]
            t = near if abs(near - cue["at"]) < 0.05 else cue["at"]
            table.append((f"Sound: {cue['sound']}", "A", float(t)))
        table.sort(key=lambda row: row[2])
        lines += [
            f"## {name}",
            "",
            f"`{path}`. Grid from {matched} of {total} onsets on the half-second grid: period "
            f"{period * 1000:.2f} ms, offset {offset * 1000:+.1f} ms.",
            "",
            "| Event | How | Time (s) | Nearest beat (s) | Offset (ms) |",
            "| --- | --- | --- | --- | --- |",
        ]
        worst = {"hits, sounds and composition": (0.0, ""), "eased, measured by fit": (0.0, "")}
        for event, how, t in table:
            b = beat(t)
            off = (t - b) * 1000
            kind = "eased, measured by fit" if how in ("E", "T") else "hits, sounds and composition"
            if abs(off) > abs(worst[kind][0]):
                worst[kind] = (off, event)
            lines.append(f"| {event} | {how} | {t:.3f} | {b:.3f} | {off:+.1f} |")
        summary.append((name, worst))
        lines.append("")
        lines += [f"Largest offset, {kind}: {w[0]:+.1f} ms, {w[1]}." for kind, w in worst.items()]
        lines.append("")
        still, at, dips = stillness(path, M["hit"])
        summary_still.append((name, still, at, dips))
        lines.append(
            f"Longest stretch before the end card with under 0.5% of the picture changing frame to frame: "
            f"{still:.2f} s" + (f", from {at:.2f} s." if still else ".")
        )
        lines.append(
            "Dips longer than 0.15 s below 55% of the brightest frame within a second: "
            + (", ".join(f"{a:.2f} s for {d:.2f} s" for a, d in dips) if dips else "none.")
        )
        lines.append("")
        found = spikes(frames, rows)
        lines += ["Frame-to-frame peaks, and the event each belongs to:", ""]
        lines += [f"- {t:.3f} s, change {v:.2f}: {', '.join(at) if at else 'NOT EXPLAINED'}" for t, v, at in found]
        lines.append("")
    open("renders/beat-check.md", "w").write("\n".join(lines))
    for name, worst in summary:
        for kind, w in worst.items():
            print(f"{name}, {kind}: {w[0]:+.1f} ms, {w[1]}")
    for name, still, at, dips in summary_still:
        print(f"{name}, longest still stretch before the end card: {still:.2f} s at {at:.2f} s")
        print(f"{name}, dips: {[(round(a, 2), round(d, 2)) for a, d in dips]}")


if __name__ == "__main__":
    main()
