import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ComputerFileReply,
  PreviewLinkReply,
  TableFileReply,
  TextFileReply,
  ulid,
  VIEWER_LIMITS,
  withAttachments,
} from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFER_BYTES } from "../agent/download.ts";
import { AgentSession } from "../agent/session.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import type { ComputerFiles } from "./computer-files.ts";
import { htmlPolicy, INERT_POLICY, SVG_POLICY } from "./preview-files.ts";
import { deliverableScenarios, deliverablesDeps } from "./testing/qa-scenarios.ts";
import { pdfOf, wavOf, xlsxOf } from "./testing/sample-files.ts";

const TOKEN = "a".repeat(43);
const PORT = 4747;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = `sk-proj-${"Q".repeat(40)}`;
const homes: string[] = [];
const checks: (() => void)[] = [];
afterEach(() => {
  for (const check of checks.splice(0)) check();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-computer-files-"));
  homes.push(home);
  const log = new EventLog(home);
  const task = log.createSession("T");
  const other = log.createSession("Other");
  const session = new AgentSession(task, "01JXYZ0000000000000000CE11", "task", log);
  const fixture = {
    home,
    assets: home,
    log,
    frames: new FrameStore(home),
    effects: [],
    session: () => session,
  };
  const deps = deliverablesDeps(fixture);
  const computer = deps.computer as ComputerFiles;
  const state = { mode: "on" as "on" | "busy" | "off", taken: 0, released: 0 };
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: log,
    deliverables: {
      ...deps,
      computer: {
        cellOf: (id) => (state.mode === "off" ? undefined : computer.cellOf(id)),
        access: (cellId, signal) => {
          if (state.mode === "busy") return "busy";
          const access = computer.access(cellId, signal);
          if (!access || access === "busy") return access;
          state.taken++;
          return { ...access, release: () => void state.released++ };
        },
      },
    },
  });
  deliverableScenarios(app, fixture);
  const replies: Response[] = [];
  // Every reply the routes made, once its body was read: no-store, and the computer let go.
  checks.push(() => {
    for (const reply of replies) expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(state.released).toBe(state.taken);
  });
  const call = async (path: string, init: RequestInit = {}) => {
    const reply = await app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}`, ...init.headers },
    });
    replies.push(reply);
    return reply;
  };
  const load = async (
    path: string,
    headers: Record<string, string> = {},
    init: RequestInit = {},
  ) => {
    const reply = await app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    });
    replies.push(reply);
    return reply;
  };
  const root = join(home, "computer-home");
  // Puts a file on the computer, named in no task.
  const put = (path: string, data: string | Buffer) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return `~/${path}`;
  };
  const changed = (path: string, data: string | Buffer, id = task) => {
    log.append(id, {
      type: "file.change",
      agent: "main",
      data: { path: put(path, data), op: "create" },
    });
    return `~/${path}`;
  };
  const sent = (files: Record<string, string | Buffer>, id = task) => {
    const paths = Object.entries(files).map(([path, data]) => put(path, data));
    log.append(id, {
      type: "message.user",
      agent: "main",
      data: { messageId: ulid(), kind: "followup", text: withAttachments("Files", paths) },
    });
    return paths;
  };
  const url = (action: string, path: string, query = "", id = task) =>
    `/api/agent/sessions/${id}/computer-files/${action}?path=${encodeURIComponent(path)}${query}`;
  const about = async (path: string) =>
    ComputerFileReply.parse(await (await call(url("about", path))).json());
  const link = async (id = task) => {
    const reply = await call(`/api/agent/sessions/${id}/preview-link`, { method: "POST" });
    return PreviewLinkReply.parse(await reply.json()).base;
  };
  const preview = (base: string, path: string, name = path.slice(path.lastIndexOf("/") + 1)) =>
    `${base}computer/${encodeURIComponent(name)}?path=${encodeURIComponent(path)}`;
  return {
    app,
    task,
    other,
    state,
    root,
    call,
    load,
    put,
    changed,
    sent,
    url,
    about,
    link,
    preview,
  };
}

const directives = (policy: string | null) =>
  new Map(
    (policy ?? "").split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values.join(" ")] as const;
    }),
  );
const picture = (width = 40, height = 30) =>
  sharp({ create: { width, height, channels: 3, background: "#3a7bd5" } })
    .png()
    .toBuffer();

describe("which files on the computer a task may read", () => {
  it("answers only with the install token, for a known task, about a path under home", async () => {
    const { app, task, other, call, url, changed } = setup();
    const path = changed("Documents/notes.txt", "hello");
    expect((await app.request(`${ORIGIN}${url("about", path)}`)).status).toBe(401);
    expect((await call(url("about", path, "", "not-a-task"))).status).toBe(400);
    expect((await call(url("about", path, "", ulid()))).status).toBe(404);
    expect((await call(url("about", path, "", other))).status).toBe(404);
    expect((await call(`/api/agent/sessions/${task}/computer-files/about`)).status).toBe(400);
    for (const bad of [
      "/etc/passwd",
      "~/../x",
      "~/a/../../b",
      "~/a//b",
      "~/a/./b",
      "~/a\\b",
      "~/a\0b",
      "~",
      `~/${"a".repeat(2000)}`,
    ])
      expect((await call(url("about", bad))).status, bad).toBe(400);
    expect((await call(url("about", path))).status).toBe(200);
  });

  it("reads only files dot changed and files sent to Downloads, as their own paths", async () => {
    const { root, put, changed, sent, about, call, url } = setup();
    const secret = put("Documents/secret.txt", "private");
    expect((await call(url("about", secret))).status).toBe(404);
    const [outside, inside] = sent({
      "Documents/elsewhere.txt": "not an upload",
      "Downloads/Uploads/one/notes.txt": "an upload",
    });
    expect((await call(url("about", outside as string))).status).toBe(404);
    expect(await about(inside as string)).toEqual({
      kind: "file",
      path: inside,
      bytes: "an upload".length,
    });
    expect(await about(changed("Projects/app/main.ts", "let a = 1;\n"))).toEqual({
      kind: "file",
      path: "~/Projects/app/main.ts",
      bytes: 11,
    });
    // A named file that turns out to be a link, or gone, is not read.
    const linked = changed("Documents/linked.txt", "x");
    rmSync(join(root, "Documents/linked.txt"));
    symlinkSync(join(root, "Documents/secret.txt"), join(root, "Documents/linked.txt"));
    expect(await about(linked)).toEqual({ kind: "none", reason: "missing" });
    const gone = changed("Documents/gone.txt", "x");
    rmSync(join(root, "Documents/gone.txt"));
    expect(await about(gone)).toEqual({ kind: "none", reason: "missing" });
    expect((await call(url("download", gone))).status).toBe(404);
  });

  it("says when the computer is busy or off, and never holds it", async () => {
    const { state, changed, about, call, url } = setup();
    const path = changed("Documents/notes.txt", "hello");
    state.mode = "busy";
    expect(await about(path)).toEqual({ kind: "none", reason: "busy" });
    expect((await call(url("download", path))).status).toBe(409);
    state.mode = "off";
    expect(await about(path)).toEqual({ kind: "none", reason: "computer_off" });
    expect(TextFileReply.parse(await (await call(url("text", path))).json())).toEqual({
      kind: "none",
      reason: "computer_off",
    });
    expect((await call(url("download", path))).status).toBe(409);
    state.mode = "on";
    expect(await about(path)).toMatchObject({ kind: "file" });
    expect(state.taken).toBeGreaterThan(0);
  });
});

describe("text, tables and downloads from the computer", () => {
  it("masks keys in text and reads a log from its end", async () => {
    const { changed, call, url } = setup();
    const text = async (path: string, query = "") =>
      TextFileReply.parse(await (await call(url("text", path, query))).json());
    expect(await text(changed("Documents/notes.txt", `first\n${KEY}\nlast`))).toEqual({
      kind: "text",
      from: "start",
      lines: ["first", "••••", "last"],
      truncated: false,
    });
    const log = changed(
      "Logs/run.log",
      `early line\n${"x".repeat(VIEWER_LIMITS.textBytes)}\nlate line\nfinal line\n`,
    );
    const tail = await text(log, "&from=end");
    expect(tail).toMatchObject({ kind: "text", from: "end", truncated: true });
    expect(tail.kind === "text" && tail.lines.slice(-3)).toEqual(["late line", "final line", ""]);
    expect(tail.kind === "text" && tail.lines).not.toContain("early line");
    expect(await text(log)).toMatchObject({ kind: "text", from: "start", truncated: true });
    expect(await text(changed("Documents/blob.txt", Buffer.from([0, 1, 2])))).toEqual({
      kind: "none",
      reason: "binary",
    });
  });

  it("reads a CSV and a workbook's sheets", async () => {
    const { sent, call, url } = setup();
    const [csv, xlsx] = sent({
      "Downloads/Uploads/a/figures.csv": "Region,Net\nNorth,1200\nSouth,900\n",
      "Downloads/Uploads/b/sales.xlsx": xlsxOf([
        {
          name: "Summary",
          rows: [
            ["Region", "Net"],
            ["North", 1200.5],
          ],
        },
        { name: "Detail", rows: [["Day"], [new Date("2026-10-09T00:00:00Z")]] },
      ]),
    });
    const table = async (path: string, query = "") =>
      TableFileReply.parse(await (await call(url("table", path, query))).json());
    expect(await table(csv as string)).toEqual({
      kind: "table",
      sheets: [],
      sheet: 0,
      rows: [
        ["Region", "Net"],
        ["North", "1200"],
        ["South", "900"],
      ],
      totalRows: 3,
      columns: 2,
    });
    expect(await table(xlsx as string)).toMatchObject({
      sheets: ["Summary", "Detail"],
      rows: [
        ["Region", "Net"],
        ["North", "1200.5"],
      ],
    });
    expect(await table(xlsx as string, "&sheet=1")).toMatchObject({
      rows: [["Day"], ["2026-10-09"]],
    });
    expect((await call(url("table", xlsx as string, "&sheet=-1"))).status).toBe(400);
    const [notes] = sent({ "Downloads/Uploads/c/notes.txt": "x" });
    expect((await call(url("table", notes as string))).status).toBe(400);
  });

  it("downloads a file whole, with its name, and answers HEAD without reading it", async () => {
    const { changed, call, url } = setup();
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    const path = changed("Documents/notes (draft) 'v2'.bin", bytes);
    const reply = await call(url("download", path));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/octet-stream");
    expect(reply.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''notes%20%28draft%29%20%27v2%27.bin",
    );
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await reply.arrayBuffer())).toEqual(bytes);
    const head = await call(url("download", path), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(await head.text()).toBe("");
  });

  it("refuses a download past the transfer size, and a thumbnail of a non-picture", async () => {
    const { root, changed, call, url } = setup();
    const huge = changed("Videos/huge.mov", "");
    truncateSync(join(root, "Videos/huge.mov"), TRANSFER_BYTES + 1);
    expect((await call(url("download", huge))).status).toBe(413);
    const photo = changed("Pictures/photo.png", await picture(1600, 1000));
    const thumb = await call(url("thumbnail", photo));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/png");
    expect(thumb.headers.get("content-security-policy")).toBe(INERT_POLICY);
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 640]);
    expect((await call(url("thumbnail", changed("Documents/a.txt", "x")))).status).toBe(415);
    expect((await call(url("thumbnail", changed("Pictures/fake.png", "not a png")))).status).toBe(
      415,
    );
  });
});

describe("computer files by preview link", () => {
  it("names a picture's type from its bytes and downloads it when opened on its own", async () => {
    const { changed, load, link, preview } = setup();
    const png = await picture();
    const path = changed("Pictures/photo.jpg", png);
    const reply = await load(preview(await link(), path));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("image/png");
    expect(reply.headers.get("content-security-policy")).toBe(INERT_POLICY);
    expect(reply.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''photo.jpg");
    expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reply.headers.get("x-dns-prefetch-control")).toBe("off");
    expect(Buffer.from(await reply.arrayBuffer())).toEqual(png);
    const fake = changed("Pictures/fake.png", "<svg><script>1</script></svg>");
    expect((await load(preview(await link(), fake))).status).toBe(415);
  });

  it("serves an SVG masked and inert, and a page quieted, in place", async () => {
    const { changed, load, link, preview } = setup();
    const base = await link();
    const svg = await load(
      preview(
        base,
        changed(
          "Pictures/diagram.svg",
          `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/a')"><text>${KEY}</text></svg>`,
        ),
      ),
    );
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe(SVG_POLICY);
    expect(svg.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''diagram.svg");
    expect(await svg.text()).not.toContain(KEY);
    const page = await load(
      preview(
        base,
        changed(
          "Sites/page.html",
          `<script>fetch("/x")</script><link rel=preconnect href=https://a.example><p>${KEY}</p>`,
        ),
      ),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(htmlPolicy(ORIGIN, base));
    expect(directives(page.headers.get("content-security-policy")).has("script-src")).toBe(false);
    expect(page.headers.get("content-disposition")).toBeNull();
    const body = await page.text();
    expect(body).not.toContain("preconnect");
    expect(body).toContain("<p>••••</p>");
  });

  it("answers byte ranges for media and PDFs, and serves nothing else", async () => {
    const { root, changed, sent, load, link, preview } = setup();
    const wav = wavOf(0.1);
    const [tone, pdf] = sent({
      "Downloads/Uploads/a/tone.wav": wav,
      "Downloads/Uploads/b/brief.pdf": pdfOf([{ title: "One", lines: ["a"] }]),
    });
    const base = await link();
    const part = await load(preview(base, tone as string), { range: "bytes=4-11" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("audio/wav");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${wav.length}`);
    expect(part.headers.get("content-length")).toBe("8");
    expect(Buffer.from(await part.arrayBuffer())).toEqual(wav.subarray(4, 12));
    const end = await load(preview(base, tone as string), { range: "bytes=-4" });
    expect(Buffer.from(await end.arrayBuffer())).toEqual(wav.subarray(-4));
    const past = await load(preview(base, tone as string), { range: `bytes=${wav.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${wav.length}`);
    const head = await load(preview(base, tone as string), {}, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(wav.length));
    const whole = await load(preview(base, pdf as string));
    expect(whole.headers.get("content-type")).toBe("application/pdf");
    expect((await whole.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await load(preview(base, changed("Documents/notes.md", "# hi")))).status).toBe(404);
    expect((await load(preview(base, changed("Sites/page.css", "p {}")))).status).toBe(404);
    const big = changed("Pictures/big.png", "");
    truncateSync(join(root, "Pictures/big.png"), VIEWER_LIMITS.pictureBytes + 1);
    expect((await load(preview(base, big))).status).toBe(413);
  });

  it("serves a file only under its own name, by a link for its own task", async () => {
    const { other, state, changed, load, link, preview } = setup();
    const path = changed("Pictures/photo.png", await picture());
    const base = await link();
    expect((await load(preview(base, path, "other.png"))).status).toBe(404);
    expect(
      (await load(preview(base, "~/Pictures/../Pictures/photo.png", "photo.png"))).status,
    ).toBe(404);
    expect((await load(preview(await link(other), path))).status).toBe(404);
    expect((await load(preview(`/file-previews/${"A".repeat(43)}/`, path))).status).toBe(404);
    state.mode = "busy";
    expect((await load(preview(base, path))).status).toBe(503);
    state.mode = "on";
    const shown = await load(preview(base, path));
    expect(shown.status).toBe(200);
    await shown.arrayBuffer();
  });
});

it("the fixture puts files on the computer, sent with a message and changed by dot", async () => {
  const { app, call, url, about } = setup();
  const reply = await app.request(`${ORIGIN}/__qa/computer-files`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` },
  });
  const { uploads, changed } = (await reply.json()) as { uploads: string[]; changed: string[] };
  expect(uploads.map((path) => path.slice(path.lastIndexOf("/") + 1))).toEqual([
    "photo.png",
    "brief.pdf",
    "figures.csv",
    "main.ts",
    "firmware.bin",
    "clip.wav",
  ]);
  expect(changed).toEqual(["~/Documents/report.md", "~/Projects/app/src/server.ts"]);
  for (const path of [...uploads, ...changed])
    expect(await about(path), path).toMatchObject({ kind: "file", path });
  const report = TextFileReply.parse(await (await call(url("text", changed[0] as string))).json());
  expect(report.kind === "text" && report.lines).toContain(
    "- Net revenue rose 9.4% on the quarter.",
  );
  const photo = await sharp(
    Buffer.from(await (await call(url("download", uploads[0] as string))).arrayBuffer()),
  ).metadata();
  expect([photo.width, photo.height]).toEqual([1600, 1000]);
});
