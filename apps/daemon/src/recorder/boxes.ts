// ISO BMFF pieces the recorder writes or walks itself: the top-level box walk used by recovery,
// and the fragment random-access box (mfra) that makes a cut-off or still-growing recording
// seekable without reading every moof. Times are MEDIA_TIMESCALE ticks: session µs.

// mediabunny numbers the recording's only track 1.
export const TRACK_ID = 1;

export interface TopBox {
  type: string;
  start: number;
  size: number;
}

// Complete top-level boxes from `from`; stops at the first box that is cut off or malformed.
export function topLevelBoxes(buf: Uint8Array, from = 0): TopBox[] {
  if (!Number.isSafeInteger(from) || from < 0) return [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: TopBox[] = [];
  let at = from;
  while (at + 8 <= buf.length) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > buf.length) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (!Number.isSafeInteger(size) || size < header || at + size > buf.length) break;
    const type = String.fromCharCode(
      buf[at + 4] ?? 0,
      buf[at + 5] ?? 0,
      buf[at + 6] ?? 0,
      buf[at + 7] ?? 0,
    );
    boxes.push({ type, start: at, size });
    at += size;
  }
  return boxes;
}

export interface RandomAccessEntry {
  startMicros: number;
  moofOffset: number;
}

// mfra { tfra v1 (64-bit time and offset, 32-bit traf/trun/sample numbers), mfro }, as mediabunny
// writes it itself, so its demuxer finds every fragment from the file's last 16 bytes.
export function mfraBox(entries: RandomAccessEntry[]): Uint8Array {
  for (const entry of entries) {
    if (![entry.startMicros, entry.moofOffset].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError("random-access time and offset must be nonnegative safe integers");
  }
  const tfraSize = 8 + 4 + 12 + entries.length * 28;
  const mfroSize = 16;
  const size = 8 + tfraSize + mfroSize;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  v.setUint32(0, size);
  tag(4, "mfra");
  v.setUint32(8, tfraSize);
  tag(12, "tfra");
  v.setUint32(16, 1 << 24);
  v.setUint32(20, TRACK_ID);
  v.setUint32(24, 0b111111);
  v.setUint32(28, entries.length);
  let at = 32;
  for (const e of entries) {
    v.setBigUint64(at, BigInt(e.startMicros));
    v.setBigUint64(at + 8, BigInt(e.moofOffset));
    v.setUint32(at + 16, 1);
    v.setUint32(at + 20, 1);
    v.setUint32(at + 24, 1);
    at += 28;
  }
  v.setUint32(at, mfroSize);
  tag(at + 4, "mfro");
  v.setUint32(at + 8, 0);
  v.setUint32(at + 12, size);
  return out;
}
