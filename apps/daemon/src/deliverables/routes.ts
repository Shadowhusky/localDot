import {
  CompareReply,
  clipPatch,
  type FileVersion,
  FileVersionsReply,
  fileKind,
  PREVIEW_LIMITS,
  ULID_PATTERN,
  unifiedDiff,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { DownloadError, downloadFile } from "../agent/download.ts";
import { outputNameProblem, outputPath } from "../agent/output-store.ts";
import type { EventLog } from "../event-log.ts";
import { fileVersions } from "./lineage.ts";
import type { Previews } from "./previews.ts";
import { StoredFiles } from "./stored.ts";
import type { TaskScanner } from "./task-scan.ts";

export interface DeliverablesDeps {
  home: string;
  port: number;
  eventLog: Pick<EventLog, "hasSession" | "logFile">;
  scanner: Pick<TaskScanner, "scan">;
  previews: Pick<Previews, "preview">;
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
  for (const path of [`${file}/*`, "/api/agent/sessions/:id/proof"])
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
        return new TextDecoder("utf-8", { fatal: true }).decode(read.head).replace(/\r\n?/g, "\n");
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
}
