// A tiny, valid H.264 Constrained Baseline stream for tests, with no encoder: every coded
// macroblock is I_PCM, so a decoded frame carries exact sample values. A key frame fills the
// picture with its GOP's level; the p-th frame after it paints macroblock p − 1 white and skips
// the rest, so only a decoder that ran forward from the key frame shows the right picture, and
// the picture tells which frame it is (`frameOfLuma`).

export const SYNTH_WHITE = 235;
export const SYNTH_CODEC = "avc1.42c01e";

export interface SynthOptions {
  widthMbs: number;
  heightMbs: number;
  keyEvery: number;
}

export interface SynthFrame {
  index: number;
  key: boolean;
  data: Uint8Array;
}

export function keyLevel(gop: number): number {
  return 16 + ((gop * 29) % 190);
}

class Bits {
  readonly bytes: number[] = [];
  #cur = 0;
  #n = 0;

  u(bits: number, value: number): void {
    for (let i = bits - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }

  bit(b: number): void {
    this.#cur = (this.#cur << 1) | b;
    this.#n += 1;
    if (this.#n === 8) {
      this.bytes.push(this.#cur);
      this.#cur = 0;
      this.#n = 0;
    }
  }

  ue(value: number): void {
    const v = value + 1;
    const len = 32 - Math.clz32(v);
    this.u(len - 1, 0);
    this.u(len, v);
  }

  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  align(): void {
    while (this.#n !== 0) this.bit(0);
  }

  trailing(): Uint8Array {
    this.bit(1);
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

// Annex B start code, NAL header, and the RBSP with emulation-prevention bytes.
function nal(refIdc: number, type: number, rbsp: Uint8Array): Uint8Array {
  const out = [0, 0, 0, 1, (refIdc << 5) | type];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

// profile 66, constraint_set0+1, level 3.0; sps 0; log2_max_frame_num 4; POC type 2; one reference
// frame; frame_mbs_only; direct_8x8_inference; no cropping, no VUI.
function sps(o: SynthOptions): Uint8Array {
  const b = new Bits();
  b.u(8, 66);
  b.u(8, 0xc0);
  b.u(8, 30);
  b.ue(0);
  b.ue(0);
  b.ue(2);
  b.ue(1);
  b.bit(0);
  b.ue(o.widthMbs - 1);
  b.ue(o.heightMbs - 1);
  b.bit(1);
  b.bit(1);
  b.bit(0);
  b.bit(0);
  return nal(3, 7, b.trailing());
}

// CAVLC, one slice group, one reference index, QP 26, deblocking control present.
function pps(): Uint8Array {
  const b = new Bits();
  b.ue(0);
  b.ue(0);
  b.bit(0);
  b.bit(0);
  b.ue(0);
  b.ue(0);
  b.ue(0);
  b.bit(0);
  b.u(2, 0);
  b.se(0);
  b.se(0);
  b.se(0);
  b.bit(1);
  b.bit(0);
  b.bit(0);
  return nal(3, 8, b.trailing());
}

function pcm(b: Bits, luma: number): void {
  b.align();
  for (let i = 0; i < 256; i++) b.u(8, luma);
  for (let i = 0; i < 128; i++) b.u(8, 128);
}

// IDR I slice: every macroblock I_PCM (mb_type 25) at the GOP's level; deblocking off.
function idr(o: SynthOptions, gop: number): Uint8Array {
  const b = new Bits();
  b.ue(0);
  b.ue(7);
  b.ue(0);
  b.u(4, 0);
  b.ue(gop % 2);
  b.bit(0);
  b.bit(0);
  b.se(0);
  b.ue(1);
  for (let mb = 0; mb < o.widthMbs * o.heightMbs; mb++) {
    b.ue(25);
    pcm(b, keyLevel(gop));
  }
  return nal(3, 5, b.trailing());
}

// P slice: skip to macroblock `mb`, paint it white as I_PCM (mb_type 5 + 25), skip the rest.
function paint(o: SynthOptions, frameNum: number, mb: number): Uint8Array {
  const total = o.widthMbs * o.heightMbs;
  const b = new Bits();
  b.ue(0);
  b.ue(5);
  b.ue(0);
  b.u(4, frameNum % 16);
  b.bit(0);
  b.bit(0);
  b.bit(0);
  b.se(0);
  b.ue(1);
  b.ue(mb);
  b.ue(30);
  pcm(b, SYNTH_WHITE);
  if (mb < total - 1) b.ue(total - 1 - mb);
  return nal(2, 1, b.trailing());
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function synthFrame(o: SynthOptions, index: number): SynthFrame {
  validateOptions(o);
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError("index must be a nonnegative safe integer");
  if (o.keyEvery < 1 || o.keyEvery > o.widthMbs * o.heightMbs) {
    throw new RangeError("keyEvery must reserve an identifying background macroblock");
  }
  const gop = Math.floor(index / o.keyEvery);
  const p = index % o.keyEvery;
  if (p === 0) return { index, key: true, data: concat([sps(o), pps(), idr(o, gop)]) };
  return { index, key: false, data: paint(o, p, p - 1) };
}

export function synthStream(o: SynthOptions, count: number): SynthFrame[] {
  validateOptions(o);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError("count must be a nonnegative safe integer");
  return Array.from({ length: count }, (_, i) => synthFrame(o, i));
}

// The frame a decoded picture shows, from the mean luma of each macroblock (row-major).
export function frameOfLuma(o: SynthOptions, mbLuma: number[]): number {
  validateOptions(o);
  if (mbLuma.length !== o.widthMbs * o.heightMbs || mbLuma.some((v) => !Number.isFinite(v)))
    throw new RangeError("one finite luma value per macroblock is required");
  let white = 0;
  while (white < mbLuma.length && Math.abs((mbLuma[white] ?? 0) - SYNTH_WHITE) <= 2) white++;
  if (white >= o.keyEvery) throw new Error("picture has more white blocks than this GOP permits");
  const base = mbLuma[white];
  if (base === undefined) throw new Error("picture has no identifying background block");
  const level = Math.round(base);
  if (mbLuma.slice(white).some((value) => Math.round(value) !== level))
    throw new Error("picture has a misplaced white block or mixed GOP backgrounds");
  // I_PCM supplies exact luma; choose the nearest integer level rather than the
  // first level within ±2, which misidentifies later GOPs. Levels repeat after 190.
  for (let gop = 0; gop < 190; gop++) {
    if (keyLevel(gop) === Math.round(base)) return gop * o.keyEvery + white;
  }
  throw new Error(`no GOP has level ${base}`);
}

function validateOptions(o: SynthOptions): void {
  if (![o.widthMbs, o.heightMbs, o.keyEvery].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new RangeError("dimensions and keyEvery must be positive safe integers");
  }
  if (o.keyEvery > o.widthMbs * o.heightMbs) {
    throw new RangeError("keyEvery must reserve an identifying background macroblock");
  }
}
