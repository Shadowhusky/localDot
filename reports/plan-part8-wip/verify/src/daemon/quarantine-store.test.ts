import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadKind } from "./download-kind.ts";
import { QuarantineError, QuarantineStore } from "./quarantine-store.ts";

const CELL = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
let n = 0;
const ids = () => `01J9ZQ3V8Y7X6W5T4S3R2Q${String(++n).padStart(4, "0")}`;
async function* chunks(...parts: (string | Buffer)[]) {
  for (const p of parts) yield Buffer.from(p);
}

describe("QuarantineStore (Review Focus 2)", () => {
  it("keeps a download on the Mac only, 0600 in a 0700 folder, hashed and classified", async () => {
    const home = mkdtempSync(join(tmpdir(), "ld-q-"));
    const store = new QuarantineStore(home, ids);
    const item = await store.add(chunks("\x7fELF", "rest"), { cellId: CELL, name: "invoice\u{202e}fdp.exe", source: "dl.example.com" });
    expect(item).toMatchObject({ name: "invoicefdp.exe", bytes: 8, kind: "program", state: "held", source: "dl.example.com" });
    expect(item.sha256).toBe(createHash("sha256").update("\x7fELFrest").digest("hex"));
    expect(statSync(store.blobPath(item.id)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "quarantine", item.id)).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(home, "quarantine", item.id)).sort()).toEqual(["blob", "item.json"]);
  });

  it("stops a download at the file cap and at the total cap, leaving nothing behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "ld-q-"));
    const store = new QuarantineStore(home, ids, Date.now, { file: 10, total: 15 });
    await expect(store.add(chunks("123456", "789012"), { cellId: CELL, name: "big", source: "x" })).rejects.toMatchObject({ status: 413 });
    await store.add(chunks("1234567890"), { cellId: CELL, name: "ten", source: "x" });
    await expect(store.add(chunks("123456"), { cellId: CELL, name: "more", source: "x" })).rejects.toMatchObject({ status: 507 });
    expect(readdirSync(join(home, "quarantine"))).toHaveLength(1);
  });

  it("forgets an incomplete folder at start, and discards held downloads after seven days", async () => {
    const home = mkdtempSync(join(tmpdir(), "ld-q-"));
    let now = Date.parse("2026-10-01T00:00:00Z");
    const store = new QuarantineStore(home, ids, () => now);
    const item = await store.add(chunks("%PDF-1.7"), { cellId: CELL, name: "a.pdf", source: "x" });
    mkdirSync(join(home, "quarantine", "01J9ZQ3V8Y7X6W5T4S3R2Q9999"));
    writeFileSync(join(home, "quarantine", "01J9ZQ3V8Y7X6W5T4S3R2Q9999", "blob.part"), "half");
    const again = new QuarantineStore(home, ids, () => now);
    expect(again.list().map((i) => i.id)).toEqual([item.id]);
    expect(existsSync(join(home, "quarantine", "01J9ZQ3V8Y7X6W5T4S3R2Q9999"))).toBe(false);
    now += 8 * 24 * 3600 * 1000;
    expect(again.expire().map((i) => i.state)).toEqual(["discarded"]);
    expect(existsSync(again.blobPath(item.id))).toBe(false);
    expect(() => again.mark(item.id, { state: "released", releasedTo: "computer" })).toThrow(QuarantineError);
  });

  it("refuses ids that are not ULIDs, so no path is built from one", () => {
    const store = new QuarantineStore(mkdtempSync(join(tmpdir(), "ld-q-")), ids);
    expect(store.get("../../etc")).toBeUndefined();
    expect(() => store.blobPath("../x")).toThrow(QuarantineError);
  });
});

describe("downloadKind", () => {
  it("classifies by content first, then by name", () => {
    expect(downloadKind("notes.txt", Buffer.from("#!/bin/sh"))).toBe("program");
    expect(downloadKind("photo.jpg", Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe("program");
    expect(downloadKind("report.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("document");
    expect(downloadKind("bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("archive");
    expect(downloadKind("setup.AppImage", Buffer.from("x"))).toBe("program");
    expect(downloadKind("a.pdf", Buffer.from("%PDF"))).toBe("document");
    expect(downloadKind("a.png", Buffer.from("x"))).toBe("media");
    expect(downloadKind("blob", Buffer.from("x"))).toBe("other");
  });
});
