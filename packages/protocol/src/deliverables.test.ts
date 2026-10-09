import { describe, expect, it } from "vitest";
import {
  canOpenOnMac,
  fileExtension,
  fileKind,
  isPresentation,
  JsonPreview,
  ReviseLink,
  textFormat,
  viewerKind,
} from "./deliverables.ts";
import { parseEvent } from "./events.ts";
import { ulid } from "./ids.ts";
import { DoneInput } from "./tools.ts";

describe("file kinds", () => {
  it("classifies by the last extension, case-insensitively", () => {
    expect(fileKind("Chart.PNG")).toBe("image");
    expect(fileKind("totals.csv")).toBe("table");
    expect(fileKind("notes.md")).toBe("text");
    expect(fileKind("budget.xlsx")).toBe("office");
    expect(fileKind("scan.pdf")).toBe("pdf");
    expect(fileKind("report.pdf.command")).toBe("attachment");
    expect(fileKind(".bashrc")).toBe("attachment");
    expect(fileKind("README")).toBe("attachment");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });
  it("never previews svg or html inline, and decodes only common raster pictures", () => {
    for (const name of [
      "logo.svg",
      "page.html",
      "page.htm",
      "page.xhtml",
      "feed.xml",
      "scan.tiff",
      "photo.avif",
      "photo.heic",
    ])
      expect(fileKind(name), name).toBe("attachment");
  });
  it("opens documents and media on the Mac but nothing that can run, browse or carry macros", () => {
    for (const name of ["a.pdf", "a.xlsx", "a.csv", "a.png", "a.docx", "a.mp4", "a.md", "a.tiff"])
      expect(canOpenOnMac(name), name).toBe(true);
    for (const name of [
      "a.command",
      "a.sh",
      "a.app",
      "a.pkg",
      "a.dmg",
      "a.terminal",
      "a.scpt",
      "a.html",
      "a.svg",
      "a.webloc",
      "a.xlsm",
      "a.docm",
      "a.doc",
      "a.xls",
      "a.ppt",
      "a.pps",
      "a.ppsx",
      "a.key",
      "a.jar",
      "a.json",
      "noext",
    ])
      expect(canOpenOnMac(name), name).toBe(false);
  });
});

describe("full preview kinds", () => {
  it("shows each common format its own way and anything else as details", () => {
    const kinds = Object.fromEntries(
      ["a.PNG", "a.svg", "a.pdf", "a.htm", "a.py", "a.log", "a.tsv", "a.ods", "a.m4a", "a.mov"]
        .concat(["a.docx", "a.zip", "a.tiff", "README"])
        .map((name) => [name, viewerKind(name)]),
    );
    expect(kinds).toEqual({
      "a.PNG": "picture",
      "a.svg": "svg",
      "a.pdf": "pdf",
      "a.htm": "html",
      "a.py": "text",
      "a.log": "text",
      "a.tsv": "table",
      "a.ods": "sheet",
      "a.m4a": "audio",
      "a.mov": "video",
      "a.docx": "page",
      "a.zip": "details",
      "a.tiff": "details",
      README: "details",
    });
    expect(["a.md", "a.json", "a.log", "a.txt", "a.ts"].map(textFormat)).toEqual([
      "markdown",
      "json",
      "log",
      "plain",
      "code",
    ]);
  });
  it("shows decks a slide at a time, slide shows included, and documents as pages", () => {
    for (const name of ["a.pptx", "a.PPT", "a.pps", "a.ppsx", "a.odp"]) {
      expect(viewerKind(name), name).toBe("page");
      expect(isPresentation(name), name).toBe(true);
    }
    for (const name of ["a.docx", "a.odt", "a.rtf", "a.xls", "a.pdf", "a.keynote"])
      expect(isPresentation(name), name).toBe(false);
  });
  it("keeps a .key file an attachment, as it is most often a private key", () => {
    expect(fileKind("server.key")).toBe("attachment");
    expect(viewerKind("server.key")).toBe("details");
    expect(isPresentation("server.key")).toBe(false);
  });
  it("previews code as text but never opens it on the Mac", () => {
    for (const name of ["a.py", "a.sh", "a.ts"]) {
      expect(fileKind(name), name).toBe("text");
      expect(canOpenOnMac(name), name).toBe(false);
    }
  });
});

describe("deliverable schemas", () => {
  it("bounds a text excerpt", () => {
    const lines = Array.from({ length: 41 }, () => "x");
    expect(
      JsonPreview.safeParse({ kind: "text", format: "plain", lines, truncated: true }).success,
    ).toBe(false);
    expect(
      JsonPreview.safeParse({
        kind: "text",
        format: "plain",
        lines: ["x".repeat(241)],
        truncated: false,
      }).success,
    ).toBe(false);
  });
  it("puts an optional version on result files and a revise link on session.start", () => {
    const base = { v: 1, id: ulid(), seq: 0, t: 0, agent: "main" };
    const result = parseEvent({
      ...base,
      type: "task.result",
      data: { summary: "ok", files: [{ name: "a.csv", path: "a.csv", bytes: 3, version: 2 }] },
    });
    expect(result.type === "task.result" && result.data.files[0]?.version).toBe(2);
    const link = { sessionId: ulid(), name: "a.csv", version: 1 };
    const start = parseEvent({
      ...base,
      type: "session.start",
      data: { screen: { w: 1, h: 1, scale: 1 }, os: "linux", revises: link },
    });
    expect(start.type === "session.start" && start.data.revises).toEqual(link);
    expect(ReviseLink.safeParse({ ...link, version: 0 }).success).toBe(false);
    expect(ReviseLink.safeParse({ ...link, name: "../x" }).success).toBe(false);
    expect(ReviseLink.safeParse({ ...link, name: ".hidden" }).success).toBe(false);
  });
  it("lets done say what it checked, briefly", () => {
    expect(DoneInput.parse({ summary: "s", checked: "opens, 4 sheets" }).checked).toBe(
      "opens, 4 sheets",
    );
    expect(DoneInput.safeParse({ summary: "s", checked: "x".repeat(201) }).success).toBe(false);
  });
});
