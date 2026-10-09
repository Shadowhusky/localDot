import {
  CompareReply,
  clipPatch,
  type FileVersion,
  FileVersionsReply,
  fileKind,
  keyLikePresent,
  OpenOnMacReply,
  OpenOnMacRequest,
  PREVIEW_LIMITS,
  PreviewLinkReply,
  ProofReply,
  ReviseReply,
  ReviseRequest,
  TableFileReply,
  TextFileReply,
  ULID_PATTERN,
  ulid,
  unifiedDiff,
  VIEWER_LIMITS,
  viewerKind,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DownloadError, downloadFile } from "../agent/download.ts";
import { outputNameProblem, outputPath } from "../agent/output-store.ts";
import type { UploadAccess } from "../agent/routes.ts";
import { AgentError } from "../agent/runner.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "../gateway/frames.ts";
import { recordingCard } from "../sessions/summary.ts";
import { fileText, screenLine } from "./excerpt.ts";
import { fileVersions } from "./lineage.ts";
import { isLoopbackRequest } from "./loopback.ts";
import { type MacOpener, OpenRefused, openOnMac } from "./open-on-mac.ts";
import { previewFileRoutes } from "./preview-files.ts";
import { PreviewLinks } from "./preview-links.ts";
import type { Previews } from "./previews.ts";
import { resultProof } from "./proof.ts";
import { sheetTable } from "./sheet-file.ts";
import { StoredFiles } from "./stored.ts";
import { delimitedTable } from "./table-file.ts";
import type { TaskScanner } from "./task-scan.ts";

export interface DeliverablesDeps {
  home: string;
  port: number;
  eventLog: Pick<EventLog, "hasSession" | "logFile">;
  scanner: Pick<TaskScanner, "scan">;
  previews: Pick<Previews, "preview">;
  frames: Pick<FrameStore, "path">;
  opener: MacOpener;
  revise?: ReviseDeps;
}
export interface ReviseDeps {
  start(
    cellId: string,
    task: string,
    signal: AbortSignal,
    opts: { revises: { sessionId: string; name: string; version: number | null } },
  ): Promise<{ id: string }>;
  access(cellId: string, signal: AbortSignal): UploadAccess | undefined;
  redactUserText(text: string, sessionId?: string, cellId?: string): string;
}

const SECURE = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

export function deliverableRoutes(app: Hono, deps: DeliverablesDeps): void {
  const stored = new StoredFiles(deps.home);
  const versionsOf = (id: string, name: string) =>
    fileVersions(
      {
        scan: (s) => deps.scanner.scan(s),
        stored: (s, n, v) => {
          const rel = outputPath(s, n, v);
          return !!rel && stored.exists(rel);
        },
      },
      id,
      name,
    );
  const file = "/api/agent/sessions/:id/files/:name";
  const links = new PreviewLinks();
  previewFileRoutes(app, { home: deps.home, port: deps.port, links });
  for (const path of [
    `${file}/*`,
    "/api/agent/sessions/:id/proof",
    "/api/agent/sessions/:id/preview-link",
  ])
    app.use(path, async (c, next) => {
      const id = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(id)) return c.text("invalid task id", 400);
      const name = c.req.param("name");
      // Same rule as downloads: a stored name never starts with a dot.
      if (name !== undefined && (outputNameProblem(name) || name.startsWith(".")))
        return c.text("invalid file name", 400);
      if (!deps.eventLog.hasSession(id)) return c.text("unknown task", 404);
      await next();
    });

  app.get(`${file}/versions`, async (c) => {
    const { id, name } = c.req.param() as { id: string; name: string };
    return c.json(FileVersionsReply.parse({ name, versions: await versionsOf(id, name) }));
  });
  app.on(["GET", "HEAD"], `${file}/versions/:version`, (c) => {
    const { id, name, version } = c.req.param() as { id: string; name: string; version: string };
    if (!/^[1-9]\d{0,4}$/.test(version)) return c.text("invalid version", 400);
    try {
      return downloadFile(
        deps.home,
        id,
        name,
        c.req.raw.signal,
        c.req.raw.method === "HEAD",
        Number(version),
      );
    } catch (error) {
      if (error instanceof DownloadError) return c.text(error.message, error.status);
      throw error;
    }
  });
  const versionParam = (c: Context): number | null | undefined => {
    const raw = c.req.query("v");
    if (raw === undefined) return null;
    return /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : undefined;
  };
  app.get(`${file}/preview`, async (c) => {
    const { id, name } = c.req.param() as { id: string; name: string };
    const version = versionParam(c);
    if (version === undefined) return c.text("invalid version", 400);
    const preview = await deps.previews.preview(id, name, version, c.req.raw.signal);
    if ("png" in preview)
      return c.body(new Uint8Array(preview.png), 200, {
        ...SECURE,
        "content-type": "image/png",
        "x-localdot-preview": preview.madeBy,
      });
    return c.body(preview.json, 200, { ...SECURE, "content-type": "application/json" });
  });
  // The address the full preview loads this task's pictures, pages, PDFs and media from.
  app.post("/api/agent/sessions/:id/preview-link", (c) =>
    c.json(
      PreviewLinkReply.parse({ base: `/file-previews/${links.issue(c.req.param("id"))}/` }),
      200,
      { "cache-control": "no-store" },
    ),
  );
  app.get(`${file}/text`, (c) => {
    const { id, name } = c.req.param() as { id: string; name: string };
    const version = versionParam(c);
    if (version === undefined) return c.text("invalid version", 400);
    const rel = outputPath(id, name, version);
    const from = c.req.query("from") === "end" ? "end" : "start";
    const read =
      rel &&
      (from === "end"
        ? stored.tail(rel, VIEWER_LIMITS.textBytes)
        : stored.head(rel, VIEWER_LIMITS.textBytes));
    const reply: TextFileReply = read
      ? fileText("tail" in read ? read.tail : read.head, read.size, from)
      : { kind: "none", reason: "missing" };
    return c.json(TextFileReply.parse(reply));
  });
  app.get(`${file}/table`, async (c) => {
    const { id, name } = c.req.param() as { id: string; name: string };
    const version = versionParam(c);
    const sheet = Number(c.req.query("sheet") ?? 0);
    if (
      version === undefined ||
      !Number.isInteger(sheet) ||
      sheet < 0 ||
      sheet >= VIEWER_LIMITS.sheets
    )
      return c.text("invalid request", 400);
    const kind = viewerKind(name);
    if (kind !== "table" && kind !== "sheet") return c.text("not a table", 400);
    const rel = outputPath(id, name, version);
    const cap = kind === "table" ? VIEWER_LIMITS.tableCountBytes : VIEWER_LIMITS.sheetBytes;
    const read = rel && stored.head(rel, cap + 1);
    let reply: TableFileReply;
    if (!read) reply = { kind: "none", reason: "missing" };
    else if (kind === "table") reply = delimitedTable(name, read.head.subarray(0, cap), read.size);
    else if (read.size > cap) reply = { kind: "none", reason: "too_large" };
    else reply = await sheetTable(name, read.head, sheet, c.req.raw.signal);
    return c.json(TableFileReply.parse(reply));
  });
  app.get(`${file}/compare`, async (c) => {
    const { id, name } = c.req.param() as { id: string; name: string };
    const kind = fileKind(name);
    if (kind !== "text" && kind !== "table") return c.text("only text files can be compared", 400);
    const refs = [c.req.query("from"), c.req.query("to")].map((r) =>
      /^([0-9A-HJKMNP-TV-Z]{26})\.([1-9]\d{0,4})$/.exec(r ?? ""),
    );
    const [fromRef, toRef] = refs;
    if (!fromRef || !toRef) return c.text("invalid versions", 400);
    const versions = await versionsOf(id, name);
    const pick = (m: RegExpExecArray) =>
      versions.find((v) => v.sessionId === m[1] && v.version === Number(m[2]) && v.available);
    const [from, to] = [pick(fromRef), pick(toRef)];
    if (!from || !to) return c.text("those versions are not available", 404);
    const text = (v: FileVersion) => {
      const rel = outputPath(v.sessionId, name, v.version);
      const read = rel && stored.head(rel, PREVIEW_LIMITS.compareBytes + 1);
      if (!read || read.size > PREVIEW_LIMITS.compareBytes || read.head.includes(0))
        return undefined;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(read.head);
        // Masked as the preview masks it: no key shows and nothing disguises itself.
        return decoded.replace(/\r\n?/g, "\n").split("\n").map(screenLine).join("\n");
      } catch {
        return undefined;
      }
    };
    const [a, b] = [text(from), text(to)];
    if (a === undefined || b === undefined)
      return c.text("these versions are too large or not text", 422);
    const patch = unifiedDiff(a, b, { path: name });
    const clipped = clipPatch(patch, 64_000);
    return c.json(
      CompareReply.parse({
        from: from.label,
        to: to.label,
        patch: clipped,
        truncated: clipped !== patch,
      }),
    );
  });
  app.get("/api/agent/sessions/:id/proof", async (c) => {
    const id = c.req.param("id");
    const scan = await deps.scanner.scan(id);
    if (!scan) return c.text("unknown task", 404);
    const exists = (frameId: string) => deps.frames.path(id, frameId) !== undefined;
    return c.json(
      ProofReply.parse({
        recording: recordingCard(deps.home, id).state,
        results: scan.results.slice(-64).map((r) => resultProof(r, exists)),
      }),
    );
  });
  app.post(`${file}/open`, bodyLimit({ maxSize: 1024 }), async (c) => {
    // Checked first: nothing is read or written for a request that came through a front.
    if (!isLoopbackRequest(c, deps.port))
      return c.text("Open on Mac works only in localDot on this Mac.", 403);
    const { id, name } = c.req.param() as { id: string; name: string };
    let body: { version: number | null };
    try {
      body = OpenOnMacRequest.parse(await c.req.json());
    } catch {
      return c.text("invalid request body", 400);
    }
    const versions = await versionsOf(id, name);
    const chosen = versions.find(
      (v) => v.sessionId === id && v.version === body.version && v.available,
    );
    const rel = chosen && outputPath(id, name, chosen.version);
    if (!chosen || !rel) return c.text("That file is no longer available.", 404);
    const scan = await deps.scanner.scan(id);
    try {
      const opened = await openOnMac(
        deps.opener,
        stored.path(rel),
        { name, label: chosen.label, newest: chosen === versions.at(-1) },
        { title: scan?.title ?? null, sessionId: id },
      );
      return c.json(OpenOnMacReply.parse({ path: opened.shown, reused: opened.reused }));
    } catch (error) {
      if (error instanceof OpenRefused) return c.text(error.message, error.status);
      throw error;
    }
  });
  if (deps.revise) reviseRoute(app, deps.home, deps.revise, versionsOf);
}

// Revising a file of a task that has ended starts a new task linked to that version.
function reviseRoute(
  app: Hono,
  home: string,
  deps: ReviseDeps,
  versionsOf: (id: string, name: string) => Promise<FileVersion[]>,
): void {
  app.post(
    "/api/agent/sessions/:id/files/:name/revise",
    bodyLimit({ maxSize: 16 * 1024 }),
    async (c) => {
      const { id, name } = c.req.param() as { id: string; name: string };
      let body: ReviseRequest;
      try {
        body = ReviseRequest.parse(await c.req.json());
      } catch {
        return c.text("invalid request body", 400);
      }
      if (!body.text.trim() || !body.text.isWellFormed() || body.text.includes("\0"))
        return c.text("invalid request body", 400);
      // The same refusal as a new task, before anything is copied: redactUserText removes only
      // localDot's own tokens, not a pasted provider key.
      if (keyLikePresent(body.text))
        return c.text("Recognised API keys belong in Keys, not task text.", 400);
      const versions = await versionsOf(id, name);
      const chosen = versions.find(
        (v) => v.sessionId === id && v.version === body.version && v.available,
      );
      if (!chosen) return c.text("That file is no longer available.", 404);
      // A fresh folder each time: an earlier revise may have saved over its copy.
      const folder = `Downloads/revise-${id.slice(-6).toLowerCase()}-v${chosen.label}-${ulid().slice(-6).toLowerCase()}`;
      let access: UploadAccess | undefined;
      try {
        // Throws AgentError 409 while the user holds control or the computer is changing.
        access = deps.access(body.cellId, c.req.raw.signal);
      } catch (error) {
        if (error instanceof AgentError)
          return c.text("The computer can't take the file right now.", 409);
        throw error;
      }
      if (!access) return c.text("Turn on your computer first.", 409);
      let copied: string;
      try {
        const source = downloadFile(
          home,
          id,
          name,
          access.signal,
          false,
          chosen.version ?? undefined,
        );
        try {
          copied = await access.tools.putFile(
            `${folder}/${name}`,
            source.body as ReadableStream<Uint8Array>,
            undefined,
            access.signal,
            true,
          );
        } catch (error) {
          void source.body?.cancel().catch(() => {});
          throw error;
        }
      } catch (error) {
        if (error instanceof DownloadError) return c.text("That file is no longer available.", 404);
        // Stop or a computer change aborts the lease mid-copy: a refusal, not a 500.
        if (error instanceof AgentError || error instanceof DesktopdError || access.signal.aborted)
          return c.text("The computer can't take the file right now.", 409);
        throw error;
      } finally {
        access.release();
      }
      const task = `${body.text.trim()}\n\n(${name} v${chosen.label} is on this computer at ${copied}. Save the revised file as ${name} and hand it back with done.)`;
      try {
        const session = await deps.start(
          body.cellId,
          deps.redactUserText(task, undefined, body.cellId),
          c.req.raw.signal,
          { revises: { sessionId: id, name, version: chosen.version } },
        );
        return c.json(ReviseReply.parse({ sessionId: session.id }), 202);
      } catch (error) {
        if (error instanceof AgentError)
          return c.text(
            "The computer can't start this task now.",
            error.status === 404 ? 409 : error.status,
          );
        throw error;
      }
    },
  );
}
