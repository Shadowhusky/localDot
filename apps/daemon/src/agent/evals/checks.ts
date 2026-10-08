import sharp from "sharp";

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

export interface Image {
  width: number;
  height: number;
  // RGBA, row-major.
  data: Uint8Array;
}

const verdict = (reasons: string[]): Verdict => ({ ok: reasons.length === 0, reasons });

export async function decodeImage(bytes: Buffer): Promise<Image> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function luma(image: Image, i: number): number {
  const d = image.data;
  const alpha = (d[i + 3] ?? 255) / 255;
  const value = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
  return value * alpha + 255 * (1 - alpha);
}

// Ink widened by this many pixels on each side bridges anti-aliasing seams, not a gap the eye sees.
const SEAM_PX = 2;

// Whether the background reaches the shape's middle from the canvas edge, around or through it.
function opensToMiddle(
  width: number,
  height: number,
  ink: readonly [number, number][],
  middle: (x: number, y: number) => boolean,
): boolean {
  const seen = new Uint8Array(width * height);
  for (const [x, y] of ink)
    for (let dy = -SEAM_PX; dy <= SEAM_PX; dy++)
      for (let dx = -SEAM_PX; dx <= SEAM_PX; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) seen[ny * width + nx] = 1;
      }
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const visit = (x: number, y: number) => {
    const i = y * width + x;
    if (seen[i]) return;
    seen[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (head < tail) {
    const i = queue[head++] as number;
    const x = i % width;
    const y = (i - x) / width;
    if (middle(x, y)) return true;
    if (x > 0) visit(x - 1, y);
    if (x < width - 1) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y < height - 1) visit(x, y + 1);
  }
  return false;
}

// A closed ellipse outline: ink that is neither empty nor a filled shape, that lies on an
// elliptical band around its own bounding box, and that walls the middle off from the canvas edge.
export function ellipseVerdict(image: Image): Verdict {
  const { width, height } = image;
  const ink: [number, number][] = [];
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (luma(image, (y * width + x) * 4) < 128) {
        ink.push([x, y]);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const coverage = ink.length / (width * height);
  if (coverage < 0.002) return verdict(["the canvas has no shape on it"]);
  const reasons: string[] = [];
  if (coverage > 0.4) reasons.push(`ink covers ${(coverage * 100).toFixed(0)}% of the canvas`);
  const a = (x1 - x0 + 1) / 2;
  const b = (y1 - y0 + 1) / 2;
  if (a < width * 0.1 || b < height * 0.1)
    reasons.push("the shape is too small to be a drawn ellipse");
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const radius = (x: number, y: number) => Math.hypot((x - cx) / a, (y - cy) / b);
  let onBand = 0;
  let inside = 0;
  for (const [x, y] of ink) {
    const r = radius(x, y);
    if (r < 0.45) inside += 1;
    if (r >= 0.45 && r <= 1.05) onBand += 1;
  }
  if (inside / ink.length > 0.05) reasons.push("the shape is filled, not an outline");
  if (onBand / ink.length < 0.9) reasons.push("the ink does not follow an ellipse");
  if (opensToMiddle(width, height, ink, (x, y) => radius(x, y) < 0.45))
    reasons.push("the outline is open");
  return verdict(reasons);
}

export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`invalid colour ${hex}`);
  return [
    Number.parseInt(m[1] as string, 16),
    Number.parseInt(m[2] as string, 16),
    Number.parseInt(m[3] as string, 16),
  ];
}

const toHex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export function fillVerdict(image: Image, hex: string, tolerance = 3, share = 0.95): Verdict {
  const target = parseHex(hex);
  const d = image.data;
  let matching = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels * 4; i += 4)
    if (target.every((v, c) => Math.abs((d[i + c] ?? 0) - v) <= tolerance) && (d[i + 3] ?? 0) > 250)
      matching += 1;
  if (matching / pixels >= share) return verdict([]);
  const centre = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
  return verdict([
    `${((matching / pixels) * 100).toFixed(1)}% of the image is ${hex.toUpperCase()}; the centre is ${toHex([d[centre] ?? 0, d[centre + 1] ?? 0, d[centre + 2] ?? 0])}`,
  ]);
}

const sameCell = (got: string | undefined, want: string) => {
  const g = (got ?? "").trim();
  if (g === want) return true;
  const a = Number(g);
  const b = Number(want);
  return g !== "" && want !== "" && Number.isFinite(a) && Number.isFinite(b) && a === b;
};

export function tableVerdict(
  rows: readonly (readonly string[])[],
  expected: readonly (readonly string[])[],
): Verdict {
  const reasons: string[] = [];
  const height = Math.max(rows.length, expected.length);
  for (let r = 0; r < height; r++) {
    const width = Math.max(rows[r]?.length ?? 0, expected[r]?.length ?? 0);
    for (let c = 0; c < width; c++) {
      const want = expected[r]?.[c] ?? "";
      const got = rows[r]?.[c];
      if (!sameCell(got, want))
        reasons.push(
          `${String.fromCharCode(65 + c)}${r + 1} is ${JSON.stringify(got ?? "")}, expected ${JSON.stringify(want)}`,
        );
    }
  }
  return verdict(reasons.slice(0, 8));
}

export function jsonVerdict(text: string | undefined, expected: Record<string, unknown>): Verdict {
  if (text === undefined) return verdict(["nothing was submitted"]);
  let got: unknown;
  try {
    got = JSON.parse(text);
  } catch {
    return verdict(["the submitted file is not JSON"]);
  }
  if (!got || typeof got !== "object") return verdict(["the submitted file is not an object"]);
  const reasons = Object.entries(expected)
    .filter(([k, v]) => JSON.stringify((got as Record<string, unknown>)[k]) !== JSON.stringify(v))
    .map(
      ([k, v]) =>
        `${k} is ${JSON.stringify((got as Record<string, unknown>)[k])}, expected ${JSON.stringify(v)}`,
    );
  return verdict(reasons);
}

export interface Placement {
  dir: string;
  has: readonly string[];
  lacks: readonly string[];
}

export function placementVerdict(
  listing: Record<string, readonly string[] | undefined>,
  expected: readonly Placement[],
): Verdict {
  const reasons: string[] = [];
  for (const { dir, has, lacks } of expected) {
    const names = listing[dir];
    if (!names) {
      reasons.push(`${dir} is missing`);
      continue;
    }
    for (const name of has) if (!names.includes(name)) reasons.push(`${dir} lacks ${name}`);
    for (const name of lacks) if (names.includes(name)) reasons.push(`${dir} still has ${name}`);
  }
  return verdict(reasons);
}

export function textVerdict(text: string | undefined, expected: string): Verdict {
  if (text === undefined) return verdict(["the file is missing"]);
  if (text === expected) return verdict([]);
  return verdict([`the file reads ${JSON.stringify(text.slice(0, 200))}`]);
}
