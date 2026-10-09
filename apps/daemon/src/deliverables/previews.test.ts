import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonPreview } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Converter } from "./previews.ts";
import { cleanFixtures, deliverablesFixture } from "./testing/fixture.ts";

afterEach(cleanFixtures);
const json = async (res: Response) => JsonPreview.parse(JSON.parse(await res.text()));

describe("previews", () => {
  it("bounds a large picture to 1024 px with no metadata, and a noisy one to 2 MiB", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const photo = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: "#3a6" },
    })
      .withExif({ IFD0: { Copyright: "sample" } })
      .jpeg()
      .toBuffer();
    const noise = await sharp(randomBytes(1400 * 1050 * 4), {
      raw: { width: 1400, height: 1050, channels: 4 },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();
    f.result(id, { "photo.jpg": photo, "noise.png": noise });
    const res = await f.get(`/api/agent/sessions/${id}/files/photo.jpg/preview?v=1`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-localdot-preview")).toBe("daemon");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height, meta.exif]).toEqual([1024, 768, undefined]);
    const loud = Buffer.from(
      await (await f.get(`/api/agent/sessions/${id}/files/noise.png/preview?v=1`)).arrayBuffer(),
    );
    expect(loud.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await sharp(loud).metadata()).width ?? 0).toBeLessThanOrEqual(1024);
  });
  it("never renders svg or html, even under an image name", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>';
    f.result(id, { "logo.svg": svg, "page.html": "<script>alert(1)</script>", "fake.png": svg });
    for (const name of ["logo.svg", "page.html", "fake.png"]) {
      const res = await f.get(`/api/agent/sessions/${id}/files/${name}/preview?v=1`);
      expect(res.headers.get("content-type"), name).toBe("application/json");
      expect(await json(res), name).toEqual({ kind: "none", reason: "attachment" });
    }
  });
  it("decodes only PNG, JPEG, GIF and WebP on the Mac", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const tiff = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } })
      .tiff()
      .toBuffer();
    const heif = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.alloc(16),
    ]);
    f.result(id, { "scan.png": tiff, "photo.png": heif });
    for (const name of ["scan.png", "photo.png"])
      expect(
        await json(await f.get(`/api/agent/sessions/${id}/files/${name}/preview?v=1`)),
        name,
      ).toEqual({ kind: "none", reason: "attachment" });
  });
  it("refuses a decompression bomb before decoding it", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const bomb = await sharp({
      create: { width: 10_000, height: 10_000, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    f.result(id, { "bomb.png": bomb });
    expect(await json(await f.get(`/api/agent/sessions/${id}/files/bomb.png/preview?v=1`))).toEqual(
      {
        kind: "none",
        reason: "too_large",
      },
    );
  });
  it("excerpts the first 40 rows of a large csv into at most 96 KiB", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const rows = Array.from(
      { length: 10_000 },
      (_, i) => `${i},"quoted, ${i}",${"x".repeat(200)}`,
    ).join("\n");
    f.result(id, { "big.csv": `n,label,wide\n${rows}\n` });
    const body = await (await f.get(`/api/agent/sessions/${id}/files/big.csv/preview?v=1`)).text();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(96 * 1024);
    const preview = JsonPreview.parse(JSON.parse(body));
    expect(preview.kind === "table" && preview.rows.length).toBe(40);
    expect(preview.kind === "table" && preview.rows[1]?.[1]).toBe("quoted, 0");
    expect(preview.kind === "table" && preview.truncated).toBe(true);
  });
  it("keeps v1's bytes for v1 after v2 replaced out/<name>", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "a.txt": "first" });
    f.result(id, { "a.txt": "second" });
    const v1 = await json(await f.get(`/api/agent/sessions/${id}/files/a.txt/preview?v=1`));
    expect(v1.kind === "text" && v1.lines).toEqual(["first"]);
  });
  it("renders office files and pdfs through the converter, bounds the page image and caches it", async () => {
    const page = await sharp({
      create: { width: 2480, height: 3508, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const convert = vi.fn<Converter["convert"]>(async () => page);
    const f = deliverablesFixture({ converter: { convert } });
    const id = f.task();
    f.result(id, { "report.ods": "ods-bytes", "brief.docx": "docx-bytes", "scan.pdf": "%PDF-1.7" });
    for (const name of ["report.ods", "brief.docx", "scan.pdf"]) {
      const res = await f.get(`/api/agent/sessions/${id}/files/${name}/preview?v=1`);
      expect(res.headers.get("x-localdot-preview"), name).toBe("computer");
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0), name).toBe(1024);
    }
    await f.get(`/api/agent/sessions/${id}/files/report.ods/preview?v=1`);
    expect(convert).toHaveBeenCalledTimes(3);
    expect(existsSync(join(f.home, "sessions", id, "previews", "report.ods", "1.png"))).toBe(true);
  });
  it("says the computer is off, and caches nothing, rather than rendering on the Mac", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "report.ods": "ods-bytes" });
    expect(
      await json(await f.get(`/api/agent/sessions/${id}/files/report.ods/preview?v=1`)),
    ).toEqual({
      kind: "none",
      reason: "computer_off",
    });
    expect(existsSync(join(f.home, "sessions", id, "previews", "report.ods", "1.png"))).toBe(false);
  });
  it("answers a missing version and a malformed one", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "a.txt": "x" });
    expect(await json(await f.get(`/api/agent/sessions/${id}/files/a.txt/preview?v=9`))).toEqual({
      kind: "none",
      reason: "missing",
    });
    expect((await f.get(`/api/agent/sessions/${id}/files/a.txt/preview?v=0`)).status).toBe(400);
  });
});
