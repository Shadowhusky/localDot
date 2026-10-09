import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { CellRecord } from "./types.ts";

const fsHooks = vi.hoisted(() => ({ diskFull: false }));

// A full disk: the write lands part of its data, then fails.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
    if (!fsHooks.diskFull) return fs.writeFileSync(file, data, options);
    fs.writeFileSync(file, String(data).slice(0, 16), options);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  return { ...fs, writeFileSync };
});

const homes: string[] = [];
afterEach(() => {
  fsHooks.diskFull = false;
  vi.restoreAllMocks();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "local dot's cells-"));
  homes.push(dir);
  return dir;
};

const writeRecord = (dir: string, id: string, value: unknown) => {
  mkdirSync(join(dir, "cells", id), { recursive: true });
  writeFileSync(join(dir, "cells", id, "cell.json"), JSON.stringify(value));
};

const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

const invalid = (id: string) =>
  `cell ${id}: cell.json does not hold a valid cell record, skipping it`;

it("keeps records in its own keyd port range only", () => {
  const dir = home();
  const record = sampleRecord("01JXYZ0000000000000000ABCD");
  const e2e = new CellStore(dir, { from: 4791, to: 4796 });
  e2e.save({ ...record, keydPort: 4791 });
  expect(e2e.get(record.id)?.keydPort).toBe(4791);
  expect(e2e.folder(record.id)).toBe(join(dir, "cells", record.id));
  quietErrors();
  expect(new CellStore(dir).get(record.id)).toBeUndefined();
});

const malformed: [string, (r: CellRecord) => unknown][] = [
  ["createdAt is not a string", (r) => ({ ...r, createdAt: 1_727_776_800_000 })],
  ["scale is neither 1 nor 2", (r) => ({ ...r, scale: 3 })],
  ["keydPort is past the keyd range", (r) => ({ ...r, keydPort: 4790 })],
  ["keydPort is below the keyd range", (r) => ({ ...r, keydPort: 4759 })],
  ["keydPort is not an integer", (r) => ({ ...r, keydPort: 4760.5 })],
  ["keydPort is a string", (r) => ({ ...r, keydPort: "4760" })],
  [
    "the desktopd token is short",
    (r) => ({ ...r, tokens: { ...r.tokens, desktopd: "d".repeat(42) } }),
  ],
  [
    "the stream token is not base64url",
    (r) => ({ ...r, tokens: { ...r.tokens, stream: `${"s".repeat(42)}/` } }),
  ],
  ["the tokens are missing", (r) => ({ ...r, tokens: undefined })],
  [
    "a container name climbs out of its path segment",
    (r) => ({ ...r, docker: { ...r.docker, gate: "../networks/x" } }),
  ],
  [
    "an address ends in a newline",
    (r) => ({ ...r, docker: { ...r.docker, gateEgressIp: "172.25.0.10\n" } }),
  ],
  ["a Docker field is not a string", (r) => ({ ...r, docker: { ...r.docker, desktopIp: 17 } })],
  ["a Docker field is missing", (r) => ({ ...r, docker: { ...r.docker, homeVolume: undefined } })],
  ["docker is null", (r) => ({ ...r, docker: null })],
  ["the version is unknown", (r) => ({ ...r, v: 3 })],
  ["the id is another cell's", (r) => ({ ...r, id: ulid() })],
  ["the file holds null", () => null],
  [
    "the gate's name is another cell's",
    (r) => ({ ...r, docker: { ...r.docker, gate: `localdot-gate-${ulid()}` } }),
  ],
  [
    "the internal network's name lacks the cell id",
    (r) => ({ ...r, docker: { ...r.docker, internalNetwork: "localdot-cell" } }),
  ],
  [
    "the desktop's name is someone else's container",
    (r) => ({ ...r, docker: { ...r.docker, desktop: "postgres" } }),
  ],
  ["an address has three parts", (r) => ({ ...r, docker: { ...r.docker, desktopIp: "172.24.0" } })],
  [
    "an address has an octet past 255",
    (r) => ({ ...r, docker: { ...r.docker, gateInternalIp: "172.24.0.256" } }),
  ],
  [
    "an address is a host name",
    (r) => ({ ...r, docker: { ...r.docker, gateEgressIp: "gate.local" } }),
  ],
];

// Root reads a mode-000 file anyway, so the EACCES case can't be staged as root.
const isRoot = process.getuid?.() === 0;

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

  it.each(malformed)("skips a record when %s, with one fixed log line", (_what, edit) => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    writeRecord(dir, record.id, edit(record));
    const error = quietErrors();
    expect(store.get(record.id)).toBeUndefined();
    expect(error.mock.calls).toEqual([[invalid(record.id)]]);
  });

  it("lists the good records past a malformed one and an unreadable one, logging only error codes", () => {
    const dir = home();
    const store = new CellStore(dir);
    const older = sampleRecord(ulid(), "2026-10-01T09:00:00.000Z");
    const newer = sampleRecord(ulid(), "2026-10-01T11:00:00.000Z");
    store.save(older);
    store.save(newer);
    const bad = sampleRecord();
    writeRecord(dir, bad.id, { ...bad, scale: 3 });
    const folder = ulid();
    mkdirSync(join(dir, "cells", folder, "cell.json"), { recursive: true });
    const error = quietErrors();

    expect(store.list().map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(error.mock.calls.map((call) => call.join(" ")).sort()).toEqual(
      [invalid(bad.id), `cell ${folder}: cell.json is unreadable (EISDIR), skipping it`].sort(),
    );
  });

  it.skipIf(isRoot)("skips a cell.json it may not read, logging only the error code", () => {
    const dir = home();
    const store = new CellStore(dir);
    const good = sampleRecord();
    store.save(good);
    const locked = sampleRecord();
    store.save(locked);
    chmodSync(join(dir, "cells", locked.id, "cell.json"), 0o000);
    const error = quietErrors();

    expect(store.list().map((r) => r.id)).toEqual([good.id]);
    expect(error.mock.calls).toEqual([
      [`cell ${locked.id}: cell.json is unreadable (EACCES), skipping it`],
    ]);
  });

  it("reports the ids of the cells it skips, so a create can refuse while any exist", () => {
    const dir = home();
    const store = new CellStore(dir);
    const good = sampleRecord();
    store.save(good);
    const bad = sampleRecord();
    writeRecord(dir, bad.id, { ...bad, scale: 3 });
    const folder = ulid();
    mkdirSync(join(dir, "cells", folder, "cell.json"), { recursive: true });
    const empty = ulid();
    mkdirSync(join(dir, "cells", empty));
    const error = quietErrors();

    const { records, skipped } = store.inventory();
    expect(records.map((r) => r.id)).toEqual([good.id]);
    expect([...skipped].sort()).toEqual([bad.id, folder, empty].sort());
    expect(error.mock.calls).toContainEqual([`cell ${empty}: cell.json is missing, skipping it`]);
  });

  it("passes over folders that are not ULIDs and ULID-named files without reading them", () => {
    const dir = home();
    const store = new CellStore(dir);
    const good = sampleRecord();
    store.save(good);
    writeRecord(dir, "not-a-cell", { ...sampleRecord(), id: "not-a-cell" });
    writeFileSync(join(dir, "cells", ulid()), JSON.stringify(sampleRecord()));
    const error = quietErrors();
    expect(store.list().map((r) => r.id)).toEqual([good.id]);
    expect(error).not.toHaveBeenCalled();
  });

  it("leaves no partial temp file behind when the disk fills during a save", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    fsHooks.diskFull = true;
    expect(() => store.save({ ...record, keydPort: 4761 })).toThrow("ENOSPC");
    fsHooks.diskFull = false;
    expect(readdirSync(join(dir, "cells", record.id))).toEqual(["cell.json"]);
    expect(store.get(record.id)?.keydPort).toBe(4760);
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

  it("keeps how long a computer's operations took beside its record, 0600, until it goes", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    expect(store.timings(record.id)).toEqual({});
    store.saveTimings(record.id, { start: 8200, stop: 2100 });
    const file = join(dir, "cells", record.id, "timings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new CellStore(dir).timings(record.id)).toEqual({ start: 8200, stop: 2100 });
    expect(store.list().map((r) => r.id)).toEqual([record.id]);
    store.remove(record.id);
    expect(store.timings(record.id)).toEqual({});
  });

  it("starts a computer's timings afresh when the file can't be used", () => {
    const dir = home();
    const store = new CellStore(dir);
    const record = sampleRecord();
    store.save(record);
    const file = join(dir, "cells", record.id, "timings.json");
    for (const text of ["{not json", '{"v":1,"lastMs":{"start":-5}}', '{"v":2,"lastMs":{}}']) {
      writeFileSync(file, text);
      expect(store.timings(record.id), text).toEqual({});
    }
    expect(() => store.saveTimings(record.id, { start: 0 })).toThrow();
  });

  it("never makes a folder for the timings of a computer whose record is gone", () => {
    const dir = home();
    const store = new CellStore(dir);
    const id = ulid();
    store.saveTimings(id, { start: 8200 });
    expect(existsSync(join(dir, "cells", id))).toBe(false);
    expect(store.inventory().skipped).toEqual([]);
  });
});
