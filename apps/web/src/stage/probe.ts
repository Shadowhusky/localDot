export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Flip {
  at: number;
  luma: number;
  bright: boolean;
  presented: number;
}

let scratch = new Uint8Array(0);

// Mean of the luma plane over `rect` (plane 0 of I444/I420). S6's detector did the same.
export async function meanLuma(frame: VideoFrame, rect: ProbeRect): Promise<number> {
  const size = frame.allocationSize({ rect });
  if (scratch.byteLength < size) scratch = new Uint8Array(size);
  const [luma] = await frame.copyTo(scratch, { rect });
  if (!luma) return 0;
  let sum = 0;
  for (let row = 0; row < rect.height; row++) {
    const o = luma.offset + row * luma.stride;
    for (let col = 0; col < rect.width; col++) sum += scratch[o + col] as number;
  }
  return sum / (rect.width * rect.height);
}

export const wallNow = (): number => performance.timeOrigin + performance.now();
