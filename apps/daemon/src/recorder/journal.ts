// The open fragment's frames, written to disk as they arrive, because the muxer holds a fragment in
// memory until the next key frame closes it. One file per GOP; a record is
// u32 BE payload length | u8 flags (bit 0: key) | u64 BE session µs | payload (Annex B).

export const JOURNAL_HEADER = 13;

export interface JournalRecord {
  tMicros: number;
  key: boolean;
  data: Uint8Array;
}

export function encodeJournalRecord(r: JournalRecord): Uint8Array {
  if (!Number.isSafeInteger(r.tMicros) || r.tMicros < 0 || r.data.length > 0xffff_ffff)
    throw new RangeError("journal time and payload length must fit the record format");
  const out = new Uint8Array(JOURNAL_HEADER + r.data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, r.data.length);
  v.setUint8(4, r.key ? 1 : 0);
  v.setBigUint64(5, BigInt(r.tMicros));
  out.set(r.data, JOURNAL_HEADER);
  return out;
}

// Whole records only: a record cut off by a crash, and anything after it, is dropped.
export function decodeJournal(buf: Uint8Array): JournalRecord[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: JournalRecord[] = [];
  let at = 0;
  while (at + JOURNAL_HEADER <= buf.length) {
    const len = v.getUint32(at);
    const flags = v.getUint8(at + 4);
    if (flags > 1 || at + JOURNAL_HEADER + len > buf.length) break;
    const tMicros = Number(v.getBigUint64(at + 5));
    if (!Number.isSafeInteger(tMicros)) break;
    out.push({
      key: flags === 1,
      tMicros,
      data: buf.slice(at + JOURNAL_HEADER, at + JOURNAL_HEADER + len),
    });
    at += JOURNAL_HEADER + len;
  }
  return out;
}

// Files sort by name in time order.
export function journalName(gopStartMicros: number): string {
  if (!Number.isSafeInteger(gopStartMicros) || gopStartMicros < 0)
    throw new RangeError("journal start must be a nonnegative safe integer");
  return `${String(gopStartMicros).padStart(16, "0")}.bin`;
}
