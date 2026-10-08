import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "";
const [rootW, rootH] = (process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? "2560x1600")
  .split("x")
  .map(Number);
let captures = 0;
const mono = () => performance.timeOrigin + performance.now();
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
if (mode !== "--no-ready") emit({ ev: "ready", mono: mono() });
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  switch (req.cmd) {
    case "ping":
      if (mode === "--die-on-ping") process.exit(3);
      return emit({ id: req.id, ok: true, mono: mono() });
    case "click": {
      // The raw press lands before the reply, as it does with the real helper.
      emit({ ev: "press", kind: "button", detail: req.button ?? 1, mono: mono() });
      emit({ ev: "release", kind: "button", detail: req.button ?? 1, mono: mono() });
      return emit({ id: req.id, ok: true, button: req.button ?? 1, presses: 1 });
    }
    case "char":
      setTimeout(() => emit({ ev: "press", kind: "key", detail: 38, mono: mono() }), 5);
      return emit({ id: req.id, ok: true, keycode: 38, mods: [] });
    case "capture": {
      // Capture n of a BGRX root: pixel (x, y) is B = x % 251, G = y % 241, R = (x + y + n) % 256.
      captures += 1;
      const pixels = Buffer.alloc(rootW * rootH * 4);
      for (let y = 0, i = 0; y < rootH; y++)
        for (let x = 0; x < rootW; x++, i += 4) {
          pixels[i] = x % 251;
          pixels[i + 1] = y % 241;
          pixels[i + 2] = (x + y + captures) % 256;
        }
      writeFileSync(req.path, pixels);
      return emit({
        id: req.id,
        ok: true,
        width: rootW,
        height: rootH,
        stride: rootW * 4,
        mono: mono(),
      });
    }
    case "silent-click":
      return emit({ id: req.id, ok: true, button: 1, presses: 0 });
    case "hang":
      return;
    case "boom":
      return emit({ id: req.id, ok: false, error: "ValueError: boom" });
    case "quit":
      emit({ id: req.id, ok: true });
      return process.exit(0);
    default:
      return emit({ id: req.id, ok: false, error: `unknown command ${req.cmd}` });
  }
});
