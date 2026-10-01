import type { Presenter } from "./pump.ts";

// Part 2 paints with a 2D context; Part 3 swaps in the PixiJS presenter behind the same interface.
export function canvasPresenter(canvas: OffscreenCanvas): Presenter {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context on the stage canvas");
  return {
    present(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
    },
  };
}
