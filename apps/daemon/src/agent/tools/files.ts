import { clipPatch, type FilesInput, type ToolResult } from "@localdot/protocol";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const READ_MAX_BYTES = 64 * 1024;
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
  append(ctx, "step.start", { kind: "file" });
  append(ctx, "tool.start", { tool: "files", title: `${input.op} ${input.path}`.slice(0, 200) });
  let result: ToolResult;
  switch (input.op) {
    case "read": {
      const r = await desktop.readFile(input.path, READ_MAX_BYTES, ctx.signal);
      ctx.check();
      ctx.session.tainted = true;
      result = {
        ok: true,
        content: [
          text(
            untrusted(
              "file",
              ctx.redact(
                r.binary
                  ? `${r.path} is a binary file of ${r.bytes} bytes.`
                  : `${r.path}:\n${r.content}${r.truncated ? `\n(showing a bounded prefix of ${r.bytes} bytes)` : ""}`,
              ),
            ),
          ),
        ],
      };
      break;
    }
    case "list": {
      const r = await desktop.listDir(input.path, ctx.signal);
      ctx.check();
      ctx.session.tainted = true;
      result = {
        ok: true,
        content: [
          text(
            untrusted(
              "folder",
              ctx.redact(
                `${r.path}:\n${r.entries.map((e) => `${e.name}${e.type === "dir" ? "/" : e.type === "file" ? ` (${e.bytes} bytes)` : ""}`).join("\n")}${r.truncated ? "\n(more entries not shown)" : ""}`,
              ),
            ),
          ),
        ],
      };
      break;
    }
    case "write": {
      if (input.content === undefined) throw new Error("write needs content");
      ctx.check();
      const r = await desktop.writeFile(input.path, input.content, ctx.signal);
      ctx.check();
      append(ctx, "file.change", { path: r.path, op: r.op, patch: clipPatch(ctx.redact(r.patch)) });
      result = { ok: true, content: [text(ctx.redact(`Wrote ${r.path} (${r.bytes} bytes).`))] };
      break;
    }
    case "edit": {
      if (input.old_text === undefined || input.new_text === undefined)
        throw new Error("edit needs old_text and new_text");
      ctx.check();
      const r = await desktop.editFile(input.path, input.old_text, input.new_text, ctx.signal);
      ctx.check();
      append(ctx, "file.change", { path: r.path, op: r.op, patch: clipPatch(ctx.redact(r.patch)) });
      result = { ok: true, content: [text(ctx.redact(`Edited ${r.path}.`))] };
      break;
    }
  }
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  return result;
}
