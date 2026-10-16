import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewLinkReply, TableFileReply, TextFileReply, VIEWER_LIMITS } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { OutputStore } from "../agent/output-store.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { PageQuieter } from "./page-quieter.ts";
import { byteRange } from "./preview-files.ts";
import { PreviewLinks } from "./preview-links.ts";
import { deliverablesDeps } from "./testing/qa-scenarios.ts";
import { pdfOf, wavOf, xlsxOf } from "./testing/sample-files.ts";

const TOKEN = "a".repeat(43);
const PORT = 4747;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = `sk-proj-${"Q".repeat(40)}`;
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

// Ordinary preview routes use the production budget, including startup and TypeScript imports.
// Tests of pathological pages opt into a shorter CPU budget explicitly.
function setup(quieter = new PageQuieter()) {
  const home = mkdtempSync(join(tmpdir(), "localdot-preview-files-"));
  homes.push(home);
  const log = new EventLog(home);
  const task = log.createSession("T");
  const other = log.createSession("Other");
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: log,
    deliverables: deliverablesDeps({
      home,
      assets: home,
      log,
      frames: new FrameStore(home),
      effects: [],
      session: () => undefined,
      quieter,
    }),
  });
  const outputs = new OutputStore(home);
  const save = (name: string, data: string | Buffer, session = task) =>
    outputs.saveBytes(session, name, typeof data === "string" ? Buffer.from(data) : data);
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}`, ...init.headers },
    });
  // Loads by preview link carry no token, as a frame, picture or player does.
  const load = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    });
  const link = async (session = task) => {
    const reply = await call(`/api/agent/sessions/${session}/preview-link`, { method: "POST" });
    expect(reply.status).toBe(200);
    return PreviewLinkReply.parse(await reply.json()).base;
  };
  return { task, other, save, call, load, link };
}

// Pages parse5 spends seconds on without nesting deep or building much: each attribute of a tag is
// checked against every one before it, and each <html> tag's against all those merged so far.
const attributes = (count: number) =>
  `<p ${Array.from({ length: count }, (_, i) => `a${i}`).join(" ")}>x</p>`;
const roots = (count: number) => Array.from({ length: count }, (_, i) => `<html a${i}>`).join("");

// The longest the event loop went without a turn while the work ran.
async function stalled<T>(work: () => T | Promise<T>): Promise<[T, number]> {
  let last = performance.now();
  let most = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    most = Math.max(most, now - last);
    last = now;
  }, 10);
  try {
    const done = await work();
    return [done, Math.max(most, performance.now() - last)];
  } finally {
    clearInterval(tick);
  }
}

const directives = (policy: string | null) =>
  new Map(
    (policy ?? "").split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values.join(" ")] as const;
    }),
  );

describe("preview links", () => {
  it("are issued only with the install token, for a known task, once per task", async () => {
    const { task, call, link } = setup();
    expect(
      (
        await call(`/api/agent/sessions/${task}/preview-link`, {
          method: "POST",
          headers: { authorization: "" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/agent/sessions/01JXYZ0000000000000000AAAA/preview-link", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(await link()).toBe(await link());
  });

  it("lapse after half an hour unused, and serve one task only", () => {
    let now = 0;
    const links = new PreviewLinks(() => now);
    const ticket = links.issue("A");
    expect(links.resolve(ticket)).toBe("A");
    now += 29 * 60_000;
    expect(links.resolve(ticket)).toBe("A");
    now += 31 * 60_000;
    expect(links.resolve(ticket)).toBeUndefined();
    expect(links.issue("A")).not.toBe(ticket);
    expect(links.resolve(links.issue("B"))).toBe("B");
    expect(links.resolve("x".repeat(43))).toBeUndefined();
  });
});

describe("the preview route", () => {
  it("serves only the task's own files, by link, with no way out of its folder", async () => {
    const { other, save, load, link } = setup();
    save(
      "chart.png",
      await sharp({ create: { width: 4, height: 4, channels: 4, background: "#0000" } })
        .png()
        .toBuffer(),
    );
    save("secret.png", "x", other);
    const base = await link();
    expect((await load(`${base}chart.png`)).status).toBe(200);
    for (const path of [
      `${base}secret.png`,
      `${base}..%2F..%2Fsessions.png`,
      `${base}..%2F${other}%2Fout%2Fsecret.png`,
      `${base}%2e%2e`,
      `${base}.chart.png`,
      `${base}chart%00.png`,
      `/file-previews/${"A".repeat(43)}/chart.png`,
      "/file-previews/short/chart.png",
    ])
      expect((await load(path)).status, path).toBe(404);
    expect((await load(`${base}chart.png?v=0`)).status).toBe(400);
  });

  it("serves a page with no scripts, no connections and pictures only from its own task", async () => {
    const { save, load, link } = setup();
    save(
      "page.html",
      `<!doctype html><title>t</title><meta http-equiv="refresh" content="0;url=https://example.test/">\r\n<script>fetch("/x")</script><img src=x onerror="fetch('/y')"><a href="javascript:fetch('/z')">z</a><p>${KEY}</p>`,
    );
    const base = await link();
    const page = await load(`${base}page.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const policy = directives(page.headers.get("content-security-policy"));
    expect(policy.get("default-src")).toBe("'none'");
    expect(policy.get("img-src")).toBe(`data: ${ORIGIN}${base}`);
    expect(policy.get("style-src")).toBe(`'unsafe-inline' ${ORIGIN}${base}`);
    expect(policy.get("form-action")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'none'");
    expect(policy.get("frame-ancestors")).toBe(ORIGIN);
    expect(policy.get("sandbox")).toBe("");
    // Nothing may run or connect: no directive opens scripts, frames, fonts, media or fetches.
    for (const name of ["script-src", "script-src-elem", "connect-src", "frame-src", "child-src"])
      expect(policy.has(name), name).toBe(false);
    const body = await page.text();
    expect(body).not.toContain(KEY);
    expect(body).toContain("<p>••••</p>");
    expect(body).not.toContain("\r");
  });

  it("takes out of a page what WebKit would connect for before its policy applies", async () => {
    const { save, load, link } = setup();
    save(
      "page.html",
      `<link rel=stylesheet href=page.css><link rel=preconnect href=https://a.example><p><a href=https://b.example target=_blank ping=https://c.example>b</a></p>`,
    );
    save("deep.html", `${"<div>".repeat(300)}x`);
    const base = await link();
    const page = await load(`${base}page.html`);
    expect(page.headers.get("x-dns-prefetch-control")).toBe("off");
    const body = await page.text();
    expect(body).toContain('<link rel="stylesheet" href="page.css">');
    expect(body).toContain('<a href="https://b.example">b</a>');
    expect(body).not.toMatch(/preconnect|target|ping/);
    expect((await load(`${base}deep.html`)).status).toBe(415);
  });

  it("turns a page away as soon as it nests too deep, without reading the rest", async () => {
    const { save, load, link } = setup();
    save("lists.html", "<ul>".repeat(100_000));
    const base = await link();
    const started = performance.now();
    expect((await load(`${base}lists.html`)).status).toBe(415);
    // Includes a fresh Node child and TypeScript imports on shared CI runners. The parser's
    // depth limit is tested directly in quiet-page.test.ts; this remains bounded end to end.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("turns a page away once reading it takes too long, and never holds the daemon meanwhile", async () => {
    const { save, load, link } = setup(new PageQuieter({ cpu: 1 }));
    save("attributes.html", attributes(60_000));
    save("roots.html", roots(34_000));
    save("plain.html", "<p>A plain page</p>");
    const base = await link();
    for (const name of ["attributes.html", "roots.html"]) {
      const started = performance.now();
      const [reply, stall] = await stalled(() => load(`${base}${name}`));
      expect(reply.status, name).toBe(415);
      expect(await reply.text(), name).toBe("too complex to preview");
      expect(performance.now() - started, name).toBeLessThan(3000);
      expect(stall, name).toBeLessThan(500);
    }
    expect(await (await load(`${base}plain.html`)).text()).toContain("<p>A plain page</p>");
  }, 15_000);

  it("refuses a page that runs its reader out of heap, and goes on serving", async () => {
    const { save, load, link } = setup(new PageQuieter({ heap: 48 }));
    save("heavy.html", "<br>".repeat(1_250_000));
    save("plain.html", "<p>A plain page</p>");
    const base = await link();
    const reply = await load(`${base}heavy.html`);
    expect(reply.status).toBe(415);
    expect(await reply.text()).toBe("too complex to preview");
    expect(await (await load(`${base}plain.html`)).text()).toContain("<p>A plain page</p>");
  }, 15_000);

  it("reads a page once for HEAD and every later opening", async () => {
    const { save, load, link } = setup(new PageQuieter({ cpu: 1 }));
    save("attributes.html", attributes(60_000));
    const base = await link();
    const path = `${base}attributes.html`;
    expect((await load(path)).status).toBe(415);
    for (const method of ["HEAD", "GET", "GET"]) {
      const started = performance.now();
      expect((await load(path, {}, { method })).status, method).toBe(415);
      expect(performance.now() - started, method).toBeLessThan(250);
    }
  }, 15_000);

  it("stops reading a page once its request is gone", async () => {
    const { save, load, link } = setup();
    save("attributes.html", attributes(60_000));
    const base = await link();
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 300);
    const started = performance.now();
    const reply = await load(`${base}attributes.html`, {}, { signal: gone.signal });
    expect(reply.status).not.toBe(200);
    expect(performance.now() - started).toBeLessThan(1500);
  }, 15_000);

  it("serves an SVG as an inert picture, never as a document that runs", async () => {
    const { save, load, link } = setup();
    save(
      "diagram.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/a')"><script>fetch('/b')</script><text>${KEY}</text></svg>`,
    );
    const svg = await load(`${await link()}diagram.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    const policy = directives(svg.headers.get("content-security-policy"));
    expect(policy.get("default-src")).toBe("'none'");
    expect(policy.has("sandbox")).toBe(true);
    expect(policy.has("script-src")).toBe(false);
    expect(await svg.text()).not.toContain(KEY);
  });

  it("names a picture's type from its bytes and refuses anything else under a picture's name", async () => {
    const { save, load, link } = setup();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    save("photo.jpg", png);
    save("fake.png", '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const base = await link();
    const photo = await load(`${base}photo.jpg`);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(directives(photo.headers.get("content-security-policy")).has("sandbox")).toBe(true);
    expect((await load(`${base}fake.png`)).status).toBe(415);
  });

  it("serves nothing it does not preview, and nothing past each kind's size", async () => {
    const { save, load, link } = setup();
    save("notes.md", "# hi");
    save("tool.sh", "rm -rf /");
    save("big.svg", `<svg>${" ".repeat(VIEWER_LIMITS.svgBytes)}</svg>`);
    const base = await link();
    expect((await load(`${base}notes.md`)).status).toBe(404);
    expect((await load(`${base}tool.sh`)).status).toBe(404);
    expect((await load(`${base}big.svg`)).status).toBe(413);
  });

  it("answers byte ranges for media and PDFs, and HEAD without a body", async () => {
    const { save, load, link } = setup();
    const wav = wavOf(0.1);
    save("tone.wav", wav);
    save("report.pdf", pdfOf([{ title: "One", lines: ["a"] }]));
    const base = await link();
    const part = await load(`${base}tone.wav`, { range: "bytes=4-11" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("audio/wav");
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${wav.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(wav.subarray(4, 12));
    const end = await load(`${base}tone.wav`, { range: "bytes=-4" });
    expect(Buffer.from(await end.arrayBuffer())).toEqual(wav.subarray(-4));
    expect((await load(`${base}tone.wav`, { range: `bytes=${wav.length}-` })).status).toBe(416);
    const whole = await load(`${base}report.pdf`);
    expect(whole.headers.get("content-type")).toBe("application/pdf");
    expect((await whole.arrayBuffer()).byteLength).toBeGreaterThan(100);
    const head = await load(`${base}tone.wav`, {});
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  it("reads each numbered version, sibling stylesheets included", async () => {
    const { save, load, link } = setup();
    save("page.css", "p { color: red }");
    save("page.html", "<p>one</p>");
    save("page.html", "<p>two</p>");
    const base = await link();
    expect(await (await load(`${base}page.html?v=1`)).text()).toContain("<p>one</p>");
    expect(await (await load(`${base}page.html`)).text()).toContain("<p>two</p>");
    const css = await load(`${base}page.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("parses ranges strictly", () => {
    expect(byteRange(undefined, 10)).toBeUndefined();
    expect(byteRange("bytes=0-0", 10)).toEqual([0, 0]);
    expect(byteRange("bytes=5-", 10)).toEqual([5, 9]);
    expect(byteRange("bytes=-3", 10)).toEqual([7, 9]);
    expect(byteRange("bytes=2-100", 10)).toEqual([2, 9]);
    expect(byteRange("bytes=9-2", 10)).toBe("invalid");
    expect(byteRange("bytes=-", 10)).toBe("invalid");
    expect(byteRange("bytes=0-1,4-5", 10)).toBeUndefined();
  });
});

describe("text and tables for the full preview", () => {
  it("masks keys in text and reads a log from its end", async () => {
    const { task, save, call } = setup();
    save("notes.txt", `first\n${KEY}\nlast`);
    save("run.log", `${"x".repeat(VIEWER_LIMITS.textBytes)}\nlate line\nfinal line\n`);
    save("blob.txt", Buffer.from([0, 1, 2]));
    const text = async (name: string, query = "") =>
      TextFileReply.parse(
        await (await call(`/api/agent/sessions/${task}/files/${name}/text${query}`)).json(),
      );
    expect(await text("notes.txt")).toEqual({
      kind: "text",
      from: "start",
      lines: ["first", "••••", "last"],
      truncated: false,
    });
    const log = await text("run.log", "?from=end");
    expect(log).toMatchObject({ kind: "text", from: "end", truncated: true });
    expect(log.kind === "text" && log.lines.slice(-3)).toEqual(["late line", "final line", ""]);
    expect(await text("blob.txt")).toEqual({ kind: "none", reason: "binary" });
  });

  it("reads a workbook's sheets one at a time", async () => {
    const { task, save, call } = setup();
    save(
      "sales.xlsx",
      xlsxOf([
        {
          name: "Summary",
          rows: [
            ["Region", "Net"],
            ["North", 1200.5],
          ],
        },
        { name: "Detail", rows: [["Day"], [new Date("2026-10-09T00:00:00Z")]] },
      ]),
    );
    const table = async (sheet: number) =>
      TableFileReply.parse(
        await (
          await call(`/api/agent/sessions/${task}/files/sales.xlsx/table?sheet=${sheet}`)
        ).json(),
      );
    expect(await table(0)).toEqual({
      kind: "table",
      sheets: ["Summary", "Detail"],
      sheet: 0,
      rows: [
        ["Region", "Net"],
        ["North", "1200.5"],
      ],
      totalRows: 2,
      columns: 2,
    });
    expect((await table(1)).kind === "table" && (await table(1))).toMatchObject({
      rows: [["Day"], ["2026-10-09"]],
    });
  });

  it("stops reading a workbook once its request is gone", async () => {
    const { task, save, call } = setup();
    save("long.xlsx", xlsxOf([{ name: "S", rows: Array.from({ length: 5000 }, (_, i) => [i]) }]));
    const gone = new AbortController();
    gone.abort();
    const reply = await call(`/api/agent/sessions/${task}/files/long.xlsx/table`, {
      signal: gone.signal,
    });
    expect(await reply.json()).toEqual({ kind: "none", reason: "failed" });
  });
});
