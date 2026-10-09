import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonPreview } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Converted, type Converter, Previews } from "./previews.ts";
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
  it("excerpts source code on its card as plain text, keys masked", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "clean.py": `KEY = "sk-proj-${"Q".repeat(40)}"\nprint(KEY)\n` });
    const card = await json(await f.get(`/api/agent/sessions/${id}/files/clean.py/preview?v=1`));
    expect(card).toMatchObject({ kind: "text", format: "plain" });
    expect(card.kind === "text" && card.lines.slice(0, 2)).toEqual(['KEY = "••••"', "print(KEY)"]);
  });
  it("keeps v1's bytes for v1 after v2 replaced out/<name>", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "a.txt": "first" });
    f.result(id, { "a.txt": "second" });
    const v1 = await json(await f.get(`/api/agent/sessions/${id}/files/a.txt/preview?v=1`));
    expect(v1.kind === "text" && v1.lines).toEqual(["first"]);
  });
  it("never caches the unversioned preview, whose bytes the next version replaces", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const picture = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const shown = async () =>
      Buffer.from(
        await (await f.get(`/api/agent/sessions/${id}/files/chart.png/preview`)).arrayBuffer(),
      );
    f.result(id, { "chart.png": await picture("#ff0000") });
    const first = await shown();
    f.result(id, { "chart.png": await picture("#0000ff") });
    const second = await shown();
    const v2 = Buffer.from(
      await (await f.get(`/api/agent/sessions/${id}/files/chart.png/preview?v=2`)).arrayBuffer(),
    );
    expect(second.equals(first)).toBe(false);
    expect(second.equals(v2)).toBe(true);
    expect(existsSync(join(f.home, "sessions", id, "previews", "chart.png", "0.png"))).toBe(false);
  });
  it("renders office files and pdfs through the converter, bounds the page image and caches it", async () => {
    const page = await sharp({
      create: { width: 2480, height: 3508, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const convert = vi.fn<Converter["convert"]>(async () => page);
    const f = deliverablesFixture({ converter: { convert, pages: async () => "failed" } });
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
  it("pages an office file as a PDF made on the computer, once per version", async () => {
    const deck = Buffer.from("%PDF-1.7 24 slides");
    const pages = vi.fn<Converter["pages"]>(async () => deck);
    const f = deliverablesFixture({
      converter: { convert: async () => "failed", pages },
    });
    const id = f.task();
    f.result(id, { "deck.pptx": "pptx-bytes" });
    for (const round of [1, 2]) {
      const res = await f.get(`/api/agent/sessions/${id}/files/deck.pptx/pages?v=1`);
      expect(res.headers.get("content-type"), `round ${round}`).toBe("application/pdf");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(Buffer.from(await res.arrayBuffer()).equals(deck)).toBe(true);
    }
    expect(pages).toHaveBeenCalledOnce();
    expect(pages.mock.calls[0]?.[1]).toEqual(Buffer.from("pptx-bytes"));
    expect(existsSync(join(f.home, "sessions", id, "previews", "deck.pptx", "1.pdf"))).toBe(true);
    f.result(id, { "deck.pptx": "pptx-bytes v2" });
    await f.get(`/api/agent/sessions/${id}/files/deck.pptx/pages?v=2`);
    expect(pages).toHaveBeenCalledTimes(2);
  });
  it("keeps no pages it could not make, and makes none for a PDF or a picture", async () => {
    const answers: Awaited<ReturnType<Converter["pages"]>>[] = [
      "computer_off",
      "too_large",
      Buffer.from("<html>not a pdf"),
    ];
    const pages = vi.fn<Converter["pages"]>(async () => answers.shift() ?? "failed");
    const f = deliverablesFixture({ converter: { convert: async () => "failed", pages } });
    const id = f.task();
    f.result(id, { "brief.docx": "docx", "scan.pdf": "%PDF-1.7", "chart.png": "png" });
    const reason = async (name: string) =>
      json(await f.get(`/api/agent/sessions/${id}/files/${name}/pages?v=1`));
    expect(await reason("brief.docx")).toEqual({ kind: "none", reason: "computer_off" });
    expect(await reason("brief.docx")).toEqual({ kind: "none", reason: "too_large" });
    expect(await reason("brief.docx")).toEqual({ kind: "none", reason: "failed" });
    expect(existsSync(join(f.home, "sessions", id, "previews", "brief.docx", "1.pdf"))).toBe(false);
    expect(await reason("scan.pdf")).toEqual({ kind: "none", reason: "attachment" });
    expect(await reason("chart.png")).toEqual({ kind: "none", reason: "attachment" });
    expect(pages).toHaveBeenCalledTimes(3);
  });
  it("refuses to page an office file over 25 MiB without converting it", async () => {
    const pages = vi.fn<Converter["pages"]>(async () => Buffer.from("%PDF-1.7"));
    const f = deliverablesFixture({ converter: { convert: async () => "failed", pages } });
    const id = f.task();
    f.result(id, { "big.pptx": Buffer.alloc(25 * 1024 * 1024 + 1) });
    expect(await json(await f.get(`/api/agent/sessions/${id}/files/big.pptx/pages?v=1`))).toEqual({
      kind: "none",
      reason: "too_large",
    });
    expect(pages).not.toHaveBeenCalled();
  });
  it("makes the pages again for a preview reopened after the first was closed", async () => {
    const { previews, made, id, deck } = slowPages();
    const first = new AbortController();
    const closed = previews.pages(id, "deck.pptx", 1, first.signal);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    first.abort();
    const reopened = previews.pages(id, "deck.pptx", 1, new AbortController().signal);
    await vi.waitFor(() => expect(made).toHaveLength(2));
    made[1]?.finish(deck);
    expect(await reopened).toEqual({ pdf: deck });
    expect(made[0]?.signal.aborted).toBe(true);
    await closed;
  });
  it("shares one making of the pages, and stops it only once every request has gone", async () => {
    const { previews, made, id, deck } = slowPages();
    const leaving = new AbortController();
    const staying = new AbortController();
    const left = previews.pages(id, "deck.pptx", 1, leaving.signal);
    const stayed = previews.pages(id, "deck.pptx", 1, staying.signal);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    leaving.abort();
    expect(made[0]?.signal.aborted).toBe(false);
    made[0]?.finish(deck);
    expect(await stayed).toEqual({ pdf: deck });
    expect(await left).toEqual({ pdf: deck });
    const closing = [new AbortController(), new AbortController()];
    const gone = closing.map((c) => previews.pages(id, "deck.pptx", 2, c.signal));
    await vi.waitFor(() => expect(made).toHaveLength(2));
    for (const c of closing) c.abort();
    expect(made[1]?.signal.aborted).toBe(true);
    await Promise.all(gone);
    expect(made).toHaveLength(2);
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

// Pages that take as long as the test says, or end the moment their making is stopped.
function slowPages() {
  const made: { signal: AbortSignal; finish(answer: Converted): void }[] = [];
  const pages = (_name: string, _bytes: Buffer, signal: AbortSignal) =>
    new Promise<Converted>((resolve) => {
      made.push({ signal, finish: resolve });
      if (signal.aborted) resolve("busy");
      signal.addEventListener("abort", () => resolve("busy"), { once: true });
    });
  const f = deliverablesFixture();
  const id = f.task();
  f.result(id, { "deck.pptx": "pptx" });
  f.result(id, { "deck.pptx": "pptx v2" });
  const previews = new Previews(f.home, { convert: async () => "failed", pages });
  return { previews, made, id, deck: Buffer.from("%PDF-1.7 deck") };
}
