import { type Camera, type SessionModel, sceneAt, type View } from "@localdot/stage";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import type { ReplayProbeCommand } from "../stage/worker-protocol.ts";
import type { ReplayVideoStats } from "./replay-video.ts";

export class ReplayProbe {
  #enabled = false;
  #frame: VideoFrame | null = null;
  #source: "video" | "backdrop" | "none" = "none";

  present(frame: VideoFrame | null, source: "video" | "backdrop" | "none"): void {
    this.#source = source;
    this.#frame?.close();
    this.#frame = this.#enabled && source === "video" && frame ? frame.clone() : null;
  }

  async handle(
    command: ReplayProbeCommand,
    context: {
      presenter: PixiPresenter;
      model: SessionModel;
      view: View;
      camera: Camera;
      viewport: { w: number; h: number };
      stats: ReplayVideoStats;
    },
  ): Promise<unknown> {
    if (command.op === "enable") {
      this.#enabled = true;
      return { enabled: true };
    }
    if (!this.#enabled) return { error: "Replay probe is disabled." };
    if (command.op === "stats") return { ...context.stats, source: this.#source };
    if (command.op === "overlay-hash") {
      const pixels = context.presenter.extract(
        { x: 0, y: 0, ...context.viewport },
        "overlays",
        context.camera,
        sceneAt(context.model, command.tMs, context.view),
      );
      const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(pixels));
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    }
    if (!this.#frame || this.#source !== "video") return null;
    const frame = this.#frame.clone();
    try {
      if (command.op === "thumb") {
        if (
          !Number.isSafeInteger(command.w) ||
          !Number.isSafeInteger(command.h) ||
          command.w < 1 ||
          command.h < 1 ||
          command.w > 1024 ||
          command.h > 1024
        )
          throw new RangeError("Invalid thumbnail dimensions.");
        const canvas = new OffscreenCanvas(command.w, command.h);
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("Thumbnail drawing is unavailable.");
        drawing.drawImage(frame, 0, 0, command.w, command.h);
        return Array.from(drawing.getImageData(0, 0, command.w, command.h).data);
      }
      if (
        !Number.isSafeInteger(command.widthMbs) ||
        !Number.isSafeInteger(command.heightMbs) ||
        command.widthMbs < 1 ||
        command.heightMbs < 1 ||
        command.widthMbs * 16 > frame.displayWidth ||
        command.heightMbs * 16 > frame.displayHeight
      )
        throw new RangeError("Invalid macroblock grid.");
      if (!frame.format || !["I420", "I420A", "I422", "I444", "NV12"].includes(frame.format))
        throw new Error("The decoded frame has no supported luma plane.");
      const buffer = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buffer);
      const plane = layout[0];
      if (!plane) throw new Error("The decoded frame has no luma plane.");
      const luma: number[] = [];
      for (let blockY = 0; blockY < command.heightMbs; blockY++) {
        for (let blockX = 0; blockX < command.widthMbs; blockX++) {
          let sum = 0;
          for (let pixelY = 0; pixelY < 16; pixelY++) {
            const offset = plane.offset + (blockY * 16 + pixelY) * plane.stride + blockX * 16;
            for (let pixelX = 0; pixelX < 16; pixelX++) sum += buffer[offset + pixelX] ?? 0;
          }
          luma.push(sum / 256);
        }
      }
      return luma;
    } finally {
      frame.close();
    }
  }

  close(): void {
    this.#frame?.close();
    this.#frame = null;
    this.#source = "none";
    this.#enabled = false;
  }
}
