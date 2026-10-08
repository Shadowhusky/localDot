"""Downscale the master plates to the sizes the web app ships and encode them as WebP.

python3 -I derive.py MASTER_DIR [OUT_DIR]

MASTER_DIR holds build_plates.py's 16-bit RGBA masters. Each one is resized in linear light
(Lanczos) and encoded with lossy colour and lossless alpha. OUT_DIR defaults to the app's
apps/web/src/dot/plates. Needs ImageMagick (magick) and cwebp.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The body crossfades between three plates at every size; the soft shadow upscales cleanly.
PLATES = {
    "body-neutral": [48, 96, 192, 448],
    "body-xenon": [48, 96, 192, 448],
    "body-dim": [48, 96, 192, 448],
    "shadow": [96, 192],
}


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "apps/web/src/dot/plates"
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for plate, sizes in PLATES.items():
            master = src / f"{plate}.png"
            for px in sizes:
                png = Path(tmp) / f"{plate}-{px}.png"
                webp = out / f"{plate}-{px}.webp"
                run([
                    "magick", str(master), "-colorspace", "RGB", "-filter", "Lanczos", "-resize",
                    f"{px}x{px}", "-colorspace", "sRGB", "-depth", "8", "-strip", f"PNG32:{png}",
                ])
                quality = "80" if plate == "shadow" else "88"
                run([
                    "cwebp", "-quiet", "-q", quality, "-alpha_q", "100", "-m", "6", "-sharp_yuv",
                    "-exact", str(png), "-o", str(webp),
                ])
                total += webp.stat().st_size
                print(f"{webp.name}: {webp.stat().st_size} bytes")
    print(f"total: {total} bytes")


main()
