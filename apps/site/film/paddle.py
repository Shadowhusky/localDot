"""Where Breakout's paddle is in each frame of the clip the film plays while the visitor has control,
so the visitor's cursor can ride it. film/assets.mjs runs it:

    uv run --with numpy python paddle.py <video> <from seconds> <seconds> assets/paddle.json
"""

import json
import subprocess
import sys

import numpy as np

W, H = 480, 300
FPS = 30


def main():
    src, start, seconds, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(seconds), "-i", src,
         "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    ).stdout
    white = np.frombuffer(raw, np.uint8).reshape(-1, H, W) > 200
    # The paddle is the only white that stays in the bottom half of the game.
    rows = np.where(white[:, H // 2 :].mean(axis=(0, 2)) > 0.01)[0] + H // 2
    xs, last = [], 0.5
    for frame in white[:, rows.min() : rows.max() + 1].any(axis=1):
        # The longest run of white is the paddle; the ball can touch it but is narrower.
        edges = np.flatnonzero(np.diff(np.concatenate(([0], frame.astype(np.int8), [0]))))
        runs = edges.reshape(-1, 2)
        if len(runs):
            a, b = max(runs, key=lambda r: r[1] - r[0])
            last = round(float(a + b - 1) / 2 / W, 4)
        xs.append(last)
    json.dump({"from": start, "fps": FPS, "y": round(float(rows.mean()) / H, 4), "x": xs}, open(out, "w"))


if __name__ == "__main__":
    main()
