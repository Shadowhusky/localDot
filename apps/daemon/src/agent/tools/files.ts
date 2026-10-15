import { clipPatch, type FilesInput, type ToolContent, type ToolResult } from "@localdot/protocol";
import { DesktopdError } from "../../desktopd/client.ts";
import { raster } from "../../raster.ts";
import { beginFileTracking, finishFileTracking } from "../safety/local-cleanup.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const READ_MAX_BYTES = 64 * 1024;
// What a read or a listing shows in its step: the start of what dot was given, line by line.
const SHOWN_CHARS = 4000;
const shownPart = (said: string) =>
  said.length > SHOWN_CHARS ? `${said.slice(0, SHOWN_CHARS)}\n…` : said;
const PICTURE = /\.(?:png|jpe?g|webp|gif)$/i;
const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
// The longest side a model takes without scaling the picture down itself.
const PICTURE_SIDE = 1568;

// A picture dot reads is shown to it, as a JPEG no larger than a model uses. Anything that is not
// a picture the decoder takes stays a note.
async function picture(
  desktop: NonNullable<ReturnType<ToolDeps["desktop"]>>,
  path: string,
  bytes: number,
  signal: AbortSignal,
): Promise<Extract<ToolContent, { type: "web_image" }> | undefined> {
  if (!PICTURE.test(path) || bytes > PICTURE_MAX_BYTES) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of await desktop.fetchFile(path, signal)) {
    total += chunk.byteLength;
    if (total > PICTURE_MAX_BYTES) return undefined;
    chunks.push(chunk);
  }
  const jpeg = await raster(Buffer.concat(chunks), { limitInputPixels: 64_000_000 })
    .then((image) =>
      image
        .rotate()
        .resize(PICTURE_SIDE, PICTURE_SIDE, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer(),
    )
    .catch(() => undefined);
  return (
    jpeg && { type: "web_image", url: path, mediaType: "image/jpeg", data: jpeg.toString("base64") }
  );
}
export async function filesTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: FilesInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop) return fail("The computer is not running.");
  // The harness reading its own skill instructions is not a step dot took.
  const step: typeof append = (c, type, data) => {
    if (!ctx.callId.startsWith("skill-")) append(c, type, data);
  };
  step(ctx, "step.start", { kind: "file" });
  step(ctx, "tool.start", { tool: "files", title: `${input.op} ${input.path}`.slice(0, 200) });
  let result: ToolResult;
  try {
    switch (input.op) {
      case "read": {
        const r = await desktop.readFile(input.path, READ_MAX_BYTES, ctx.signal);
        ctx.check();
        ctx.session.tainted = true;
        ctx.session.taint.add("files", r.path, r.binary ? undefined : r.content);
        const shown = r.binary
          ? await picture(desktop, r.path, r.bytes, ctx.signal).catch(() => undefined)
          : undefined;
        ctx.check();
        const said = ctx.redact(
          shown
            ? `${r.path} is a picture of ${r.bytes} bytes; it follows.`
            : r.binary
              ? `${r.path} is a binary file of ${r.bytes} bytes.`
              : `${r.path}:\n${r.content}${r.truncated ? `\n(showing a bounded prefix of ${r.bytes} bytes)` : ""}`,
        );
        step(ctx, "tool.output", { stream: "stdout", chunk: shownPart(said) });
        result = {
          ok: true,
          fileRead: { ...r, path: ctx.redact(r.path), content: ctx.redact(r.content) },
          content: [
            text(untrusted("file", said)),
            ...(shown ? [{ ...shown, url: ctx.redact(shown.url) }] : []),
          ],
        };
        break;
      }
      case "list": {
        const r = await desktop.listDir(input.path, ctx.signal);
        ctx.check();
        ctx.session.tainted = true;
        ctx.session.taint.add("files", r.path, r.entries.map((entry) => entry.name).join("\n"));
        const said = ctx.redact(
          `${r.path}:\n${r.entries.map((e) => `${e.name}${e.type === "dir" ? "/" : e.type === "file" ? ` (${e.bytes} bytes)` : ""}`).join("\n")}${r.truncated ? "\n(more entries not shown)" : ""}`,
        );
        step(ctx, "tool.output", { stream: "stdout", chunk: shownPart(said) });
        result = {
          ok: true,
          fileList: {
            ...r,
            path: ctx.redact(r.path),
            entries: r.entries.map((e) => ({ ...e, name: ctx.redact(e.name) })),
          },
          content: [text(untrusted("folder", said))],
        };
        break;
      }
      case "write": {
        if (input.content === undefined) throw new Error("write needs content");
        ctx.check();
        const tracking = await beginFileTracking(deps, ctx, [input.path]);
        const r = await desktop.writeFile(input.path, input.content, ctx.signal);
        ctx.check();
        await finishFileTracking(deps, ctx, tracking);
        append(ctx, "file.change", {
          path: r.path,
          op: r.op,
          patch: clipPatch(ctx.redact(r.patch)),
        });
        result = { ok: true, content: [text(ctx.redact(`Wrote ${r.path} (${r.bytes} bytes).`))] };
        break;
      }
      case "edit": {
        if (input.old_text === undefined || input.new_text === undefined)
          throw new Error("edit needs old_text and new_text");
        ctx.check();
        const tracking = await beginFileTracking(deps, ctx, [input.path]);
        const r = await desktop.editFile(input.path, input.old_text, input.new_text, ctx.signal);
        ctx.check();
        await finishFileTracking(deps, ctx, tracking);
        append(ctx, "file.change", {
          path: r.path,
          op: r.op,
          patch: clipPatch(ctx.redact(r.patch)),
        });
        result = { ok: true, content: [text(ctx.redact(`Edited ${r.path}.`))] };
        break;
      }
    }
  } catch (error) {
    ctx.check();
    if (
      !(error instanceof DesktopdError) ||
      error.status !== 404 ||
      !["read", "list"].includes(input.op)
    )
      throw error;
    step(ctx, "tool.end", { ok: false });
    step(ctx, "step.end", { status: "failed", note: "The file or folder does not exist." });
    return { ...fail("The file or folder does not exist."), fileError: "not_found" };
  }
  step(ctx, "tool.end", { ok: true });
  step(ctx, "step.end", { status: "ok" });
  return result;
}
