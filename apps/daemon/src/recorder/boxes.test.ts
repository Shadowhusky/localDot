import { describe, expect, it } from "vitest";
import { mfraBox, topLevelBoxes } from "./boxes.ts";
import { decodeJournal, encodeJournalRecord, journalName } from "./journal.ts";

describe("boxes", () => {
  it("walks complete top-level boxes and stops at a cut-off one", () => {
    const box = (type: string, body: number) => {
      const b = new Uint8Array(8 + body);
      new DataView(b.buffer).setUint32(0, 8 + body);
      for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
      return b;
    };
    const whole = new Uint8Array([
      ...box("ftyp", 4),
      ...box("moov", 20),
      ...box("moof", 10),
      ...box("mdat", 30),
    ]);
    expect(topLevelBoxes(whole).map((b) => b.type)).toEqual(["ftyp", "moov", "moof", "mdat"]);
    expect(topLevelBoxes(whole.subarray(0, whole.length - 1)).map((b) => b.type)).toEqual([
      "ftyp",
      "moov",
      "moof",
    ]);
  });
  it("writes an mfra whose mfro names its own size", () => {
    const m = mfraBox([
      { startMicros: 7_200_000_000, moofOffset: 5_000_000_000 },
      { startMicros: 1, moofOffset: 2 },
    ]);
    const v = new DataView(m.buffer);
    expect(m.length).toBe(8 + (8 + 4 + 12 + 2 * 28) + 16);
    expect(v.getUint32(m.length - 4)).toBe(m.length);
    expect(v.getBigUint64(32)).toBe(7_200_000_000n);
    expect(v.getBigUint64(40)).toBe(5_000_000_000n);
  });
});

describe("journal", () => {
  it("round-trips records and drops a torn tail", () => {
    const a = { tMicros: 1_000_000, key: true, data: Uint8Array.of(0, 0, 0, 1, 0x65, 9) };
    const b = { tMicros: 1_016_667, key: false, data: Uint8Array.of(0, 0, 0, 1, 0x41, 7, 7) };
    const bytes = new Uint8Array([...encodeJournalRecord(a), ...encodeJournalRecord(b)]);
    expect(decodeJournal(bytes)).toEqual([a, b]);
    expect(decodeJournal(bytes.subarray(0, bytes.length - 2))).toEqual([a]);
    expect(journalName(1_000_000)).toBe("0000000001000000.bin");
  });
});
