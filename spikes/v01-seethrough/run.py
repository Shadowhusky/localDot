"""V0-1: split one original anime bust into layers with the hosted See-through demo."""

import json
import shutil
import sys
import time
from pathlib import Path

from gradio_client import Client, handle_file
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SPACE = "24yearsold/see-through-demo"


def run(resolution: int) -> dict:
    client = Client(SPACE, verbose=False)
    started = time.monotonic()
    psd, layers = client.predict(
        handle_file(str(OUT / "input.png")), resolution, 42, False, api_name="/inference"
    )
    elapsed = time.monotonic() - started
    run_dir = OUT / f"res{resolution}"
    if run_dir.exists():
        shutil.rmtree(run_dir)
    (run_dir / "layers").mkdir(parents=True)
    shutil.copy(psd, run_dir / "layered.psd")
    saved = []
    for i, item in enumerate(layers):
        src = Path(item["image"])
        name = f"{i:02d}-{(item.get('caption') or 'layer').replace('/', '_')}{src.suffix}"
        shutil.copy(src, run_dir / "layers" / name)
        saved.append(name)
    report = {"resolution": resolution, "seconds": round(elapsed, 1), "layers": saved}
    (run_dir / "report.json").write_text(json.dumps(report, indent=2))
    contact_sheet(run_dir)
    return report


def contact_sheet(run_dir: Path, cell: int = 256) -> None:
    files = sorted((run_dir / "layers").iterdir())
    cols = 6
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 20)), (40, 40, 40))
    draw = ImageDraw.Draw(sheet)
    for i, f in enumerate(files):
        layer = Image.open(f).convert("RGBA")
        layer.thumbnail((cell, cell))
        board = Image.new("RGBA", (cell, cell))
        for y in range(0, cell, 16):
            for x in range(0, cell, 16):
                shade = 200 if (x // 16 + y // 16) % 2 else 150
                board.paste((shade, shade, shade, 255), (x, y, x + 16, y + 16))
        board.alpha_composite(layer, ((cell - layer.width) // 2, (cell - layer.height) // 2))
        x, y = (i % cols) * cell, (i // cols) * (cell + 20)
        sheet.paste(board.convert("RGB"), (x, y + 20))
        draw.text((x + 4, y + 4), f.stem[:36], fill=(230, 230, 230))
    sheet.save(run_dir / "contact-sheet.png")


if __name__ == "__main__":
    print(json.dumps(run(int(sys.argv[1]) if len(sys.argv) > 1 else 1280), indent=2))
