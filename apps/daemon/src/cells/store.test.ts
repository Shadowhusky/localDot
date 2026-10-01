import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const home = () => mkdtempSync(join(tmpdir(), "local dot's cells-"));

describe("CellStore", () => {
  it("round-trips a record through a 0600 file in a 0700 directory", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    const file = join(dir, "cells", record.id, "cell.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cells")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "cells", record.id)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    expect(store.get(record.id)).toEqual(record);
    store.save({ ...record, keydPort: 4761 });
    expect(store.get(record.id)?.keydPort).toBe(4761);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "cells", record.id))).toEqual(["cell.json"]);
  });

  it("lists records oldest first and skips ids that are not ULIDs or files that are not records", () => {
    const dir = home();
    const store = new CellStore(dir);
    const older = sampleRecord(ulid(), "2026-10-01T09:00:00.000Z");
    const newer = sampleRecord(ulid(), "2026-10-01T11:00:00.000Z");
    store.save(newer);
    store.save(older);
    const bad = sampleRecord();
    store.save(bad);
    writeFileSync(join(dir, "cells", bad.id, "cell.json"), "{not json");
    expect(store.list().map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(store.get("../etc")).toBeUndefined();
    expect(store.get(bad.id)).toBeUndefined();
  });

  it("removes a cell directory and refuses invalid ids", () => {
    const store = new CellStore(home());
    const record = sampleRecord();
    store.save(record);
    store.remove(record.id);
    expect(store.get(record.id)).toBeUndefined();
    expect(() => store.remove("../..")).toThrow("invalid cell id");
  });

  it("refuses to save a record whose id is not a ULID", () => {
    const dir = home();
    const store = new CellStore(dir);
    expect(() => store.save({ ...sampleRecord(), id: "../escape" })).toThrow("invalid cell id");
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  it("tightens a cells folder that already exists to 0700", () => {
    const dir = home();
    mkdirSync(join(dir, "cells"));
    chmodSync(join(dir, "cells"), 0o755);
    expect(new CellStore(dir).list()).toEqual([]);
    expect(statSync(join(dir, "cells")).mode & 0o777).toBe(0o700);
  });

  it("logs a corrupt record without quoting its text, which holds the cell's tokens", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = {
      ...sampleRecord(),
      tokens: { desktopd: "D".repeat(43), stream: "S".repeat(43) },
    };
    store.save(record);
    const file = join(dir, "cells", record.id, "cell.json");
    // An unquoted token makes V8 quote the text around it in the SyntaxError's message.
    const { stream } = record.tokens;
    writeFileSync(file, readFileSync(file, "utf8").replace(`"${stream}"`, stream));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(store.get(record.id)).toBeUndefined();
      expect(error).toHaveBeenCalledOnce();
      const logged = error.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain(record.id);
      expect(logged).not.toContain("SSSS");
    } finally {
      error.mockRestore();
    }
  });
});
