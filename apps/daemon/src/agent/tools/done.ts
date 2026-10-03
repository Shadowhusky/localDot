import { basename } from "node:path";
import type { DoneInput, ToolResult } from "@localdot/protocol";
import { append, cut, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
export async function doneTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: DoneInput,
): Promise<ToolResult> {
  ctx.check();
  const desktop = deps.desktop(ctx.session.cellId);
  const files: { name: string; path: string; bytes: number }[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();
  for (const path of input.files ?? []) {
    ctx.check();
    let stream: ReadableStream<Uint8Array> | undefined;
    try {
      if (!desktop) throw new Error("The computer is not running");
      stream = await desktop.fetchFile(path, ctx.signal);
      ctx.check();
      const base = ctx
        .redact(basename(path))
        .replace(/[^\w.\- ]/g, "_")
        .slice(0, 180);
      let name = base && base !== "." && base !== ".." ? base : "file";
      for (let n = 2; taken.has(name); n++) name = `${n}-${base}`;
      taken.add(name);
      ctx.check();
      const saved = await deps.saveOutput(ctx.session.id, name, stream, {
        signal: ctx.signal,
        check: ctx.check,
      });
      ctx.check();
      files.push({ name: ctx.redact(name), path: ctx.redact(path), bytes: saved.bytes });
    } catch (error) {
      ctx.check();
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (stream && !stream.locked) await stream.cancel().catch(() => {});
    }
    ctx.check();
  }
  if (problems.length)
    return {
      ok: false,
      content: [
        text(
          `These files could not be collected; fix the paths and call done again:\n${ctx.redact(problems.join("\n"))}`,
        ),
      ],
    };
  ctx.check();
  append(ctx, "task.result", { summary: cut(ctx.redact(input.summary), 8000), files });
  return { ok: true, final: true, content: [text("Task finished.")] };
}
