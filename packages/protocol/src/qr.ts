// A QR code (ISO/IEC 18004) for a short text or link: byte mode, medium error correction, the
// smallest version that fits, and the mask with the lowest penalty. After Project Nayuki's QR Code
// generator (MIT), cut down to what a scannable link needs.

// Per version 1–40 at level M: error-correction codewords in each block, and the block count.
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
// Level M's two format bits.
const LEVEL_M = 0;

const rawModules = (version: number) => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};

const dataCodewords = (version: number) =>
  Math.floor(rawModules(version) / 8) - (ECC_PER_BLOCK[version] ?? 0) * (BLOCKS[version] ?? 0);

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], by: readonly number[]): number[] {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    by.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ multiply(coefficient, factor);
    });
  }
  return result;
}

function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version] ?? 1;
  const eccLength = ECC_PER_BLOCK[version] ?? 0;
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const by = divisor(eccLength);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const part = data.slice(k, k + shortLength - eccLength + (i < short ? 0 : 1));
    k += part.length;
    const ecc = remainder(part, by);
    if (i < short) part.push(0);
    parts.push([...part, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < (parts[0]?.length ?? 0); i++)
    parts.forEach((part, j) => {
      if (i !== shortLength - eccLength || j >= short) result.push(part[i] ?? 0);
    });
  return result;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

// Rows of dark (true) and light modules, without the quiet zone; null when the text is too long
// for any version.
export function qrModules(text: string): boolean[][] | null {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 40; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (
      bytes.length < 2 ** countBits &&
      4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8
    )
      break;
  }
  if (version > 40) return null;
  const capacity = dataCodewords(version) * 8;
  const bits: boolean[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push(bit(value, i));
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((byte, on) => (byte << 1) | (on ? 1 : 0), 0));
  for (let pad = 0xec; data.length * 8 < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = interleave(data, version);

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const put = (x: number, y: number, dark: boolean) => {
    const row = modules[y];
    const lock = fixed[y];
    if (!row || !lock) return;
    row[x] = dark;
    lock[x] = true;
  };
  for (let i = 0; i < size; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) put(x, y, distance !== 2 && distance !== 4);
      }
  const aligned = alignmentPositions(version, size);
  aligned.forEach((ay, i) => {
    aligned.forEach((ax, j) => {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === aligned.length - 1) ||
        (i === aligned.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          put(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  const format = (mask: number) => {
    const value = (LEVEL_M << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) put(8, i, bit(bits, i));
    put(8, 7, bit(bits, 6));
    put(8, 8, bit(bits, 7));
    put(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(bits, i));
    put(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      put(a, b, bit(bits, i));
      put(b, a, bit(bits, i));
    }
  }

  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        const row = modules[y];
        if (!row || fixed[y]?.[x] || index >= codewords.length * 8) continue;
        row[x] = bit(codewords[index >>> 3] ?? 0, 7 - (index & 7));
        index++;
      }
  }

  const flip = (mask: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const row = modules[y];
        if (row && !fixed[y]?.[x] && masked(mask, x, y)) row[x] = !row[x];
      }
  };
  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    flip(mask);
    format(mask);
    const score = penalty(modules);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    flip(mask);
  }
  flip(best);
  format(best);
  return modules;
}

// Runs of five or more, 2×2 blocks and imbalance between dark and light (rules 1, 2 and 4).
function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  let dark = 0;
  const at = (x: number, y: number) => modules[y]?.[x] ?? false;
  for (let y = 0; y < size; y++) {
    let rowRun = 1;
    let columnRun = 1;
    for (let x = 0; x < size; x++) {
      if (at(x, y)) dark++;
      if (x > 0) {
        rowRun = at(x, y) === at(x - 1, y) ? rowRun + 1 : 1;
        if (rowRun === 5) score += 3;
        else if (rowRun > 5) score++;
        columnRun = at(y, x) === at(y, x - 1) ? columnRun + 1 : 1;
        if (columnRun === 5) score += 3;
        else if (columnRun > 5) score++;
      }
      if (
        x < size - 1 &&
        y < size - 1 &&
        at(x, y) === at(x + 1, y) &&
        at(x, y) === at(x, y + 1) &&
        at(x, y) === at(x + 1, y + 1)
      )
        score += 3;
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}
