import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { billableChars, UsageLedger } from "./budget.ts";

const ledgerFile = () =>
  join(mkdtempSync(join(tmpdir(), "local dot's voice-")), "voice-usage.json");
const october = () => new Date("2026-10-15T12:00:00Z");

describe("billableChars", () => {
  it("counts each Chinese character twice for Azure and once for ElevenLabs", () => {
    expect(billableChars("azure", "你好, OK")).toBe(8);
    expect(billableChars("azure", "やっと東京")).toBe(7);
    expect(billableChars("elevenlabs", "你好, OK")).toBe(6);
  });
});

describe("UsageLedger", () => {
  it("allows a cloud voice until this month's characters reach its limit", () => {
    const ledger = new UsageLedger(ledgerFile(), { azure: 10, elevenlabs: 0 }, october);
    expect(ledger.allows("azure", "Hello")).toBe(true);
    ledger.record("azure", "Hello");
    expect(ledger.allows("azure", "Hello")).toBe(true);
    ledger.record("azure", "Hello");
    expect(ledger.used("azure")).toBe(10);
    expect(ledger.allows("azure", "!")).toBe(false);
    expect(ledger.allows("elevenlabs", "a")).toBe(false);
  });

  it("keeps the count in a private file and starts again each month", () => {
    const file = ledgerFile();
    new UsageLedger(file, { azure: 100, elevenlabs: 100 }, october).record(
      "elevenlabs",
      "Hi there",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      month: "2026-10",
      azure: 0,
      elevenlabs: 8,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const november = new UsageLedger(
      file,
      { azure: 100, elevenlabs: 100 },
      () => new Date("2026-11-01T00:00:00Z"),
    );
    expect(november.used("elevenlabs")).toBe(0);
  });

  it("refuses all cloud speech while the record cannot be read", () => {
    const file = ledgerFile();
    writeFileSync(file, "{not json");
    const ledger = new UsageLedger(file, { azure: 500_000, elevenlabs: 500_000 }, october);
    expect(ledger.allows("azure", "Hi")).toBe(false);
    ledger.record("azure", "Hi");
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("refuses all cloud speech once a count could not be saved, without throwing", () => {
    const file = ledgerFile();
    mkdirSync(`${file}.tmp`);
    const ledger = new UsageLedger(file, { azure: 100, elevenlabs: 100 }, october);
    expect(ledger.allows("azure", "Hi")).toBe(true);
    expect(() => ledger.record("azure", "Hi")).not.toThrow();
    expect(ledger.allows("azure", "Hi")).toBe(false);
    expect(ledger.allows("elevenlabs", "Hi")).toBe(false);
  });
});
