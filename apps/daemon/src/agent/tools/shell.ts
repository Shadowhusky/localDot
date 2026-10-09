import type { ShellInput, ToolResult } from "@localdot/protocol";
import {
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "../../desktopd/tools-client.ts";
import { untrusted } from "../untrusted.ts";
import {
  append,
  contain,
  fail,
  intentOf,
  type ToolCallContext,
  type ToolDeps,
  tail,
  text,
} from "./deps.ts";

const LOG_MAX = 256 * 1024,
  MODEL_MAX = 16 * 1024,
  FLUSH = 8 * 1024;
function prefix(s: string, bytes: number): string {
  const b = Buffer.from(s);
  if (b.length <= bytes) return s;
  let end = bytes;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}
function last(s: string, bytes: number): string {
  const b = Buffer.from(s);
  if (b.length <= bytes) return s;
  let start = b.length - bytes;
  while (start < b.length && ((b[start] ?? 0) & 0xc0) === 0x80) start++;
  return b.subarray(start).toString("utf8");
}
export async function shellTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: ShellInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop) return fail("The computer is not running.");
  append(ctx, "step.start", { kind: "shell", ...intentOf(ctx, input) });
  append(ctx, "tool.start", { tool: "shell", title: ctx.redact(input.command).slice(0, 200) });
  let logged = 0,
    outputBytes = 0,
    model = "",
    pending = "",
    stream: "stdout" | "stderr" = "stdout",
    rawFallback = "",
    lastFlush = Date.now();
  const redaction = ctx.redact.stream?.();
  const flush = () => {
    ctx.check();
    if (!pending) return;
    const chunk = prefix(pending, Math.max(0, LOG_MAX - logged));
    pending = "";
    lastFlush = Date.now();
    if (chunk) {
      logged += Buffer.byteLength(chunk);
      append(ctx, "tool.output", { stream, chunk });
    }
  };
  const consume = (safe: string, channel: "stdout" | "stderr") => {
    if (stream !== channel) flush();
    stream = channel;
    model = last(model + safe, MODEL_MAX);
    if (logged < LOG_MAX) pending = prefix(pending + safe, LOG_MAX - logged);
    if (pending.length >= FLUSH || Date.now() - lastFlush >= 100) flush();
  };
  try {
    const done = await desktop.shell(
      {
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: (input.timeout_sec ?? 120) * 1000,
      },
      (c) => {
        ctx.check();
        outputBytes += Buffer.byteLength(c.chunk);
        if (outputBytes > 1024 * 1024) throw new ShellExecutionUncertainError();
        ctx.session.tainted = true;
        if (redaction) {
          for (const part of redaction.push(c)) consume(part.chunk, part.stream);
        } else rawFallback += c.chunk;
      },
      ctx.signal,
    );
    ctx.check();
    if (redaction) {
      for (const part of redaction.finish()) consume(part.chunk, part.stream);
    } else consume(ctx.redact(rawFallback), "stdout");
    flush();
    ctx.session.tainted = true;
    if (model) ctx.session.taint.add("files", "command output", model);
    const ok = done.exitCode === 0 && !done.timedOut;
    append(ctx, "tool.end", { ok, ...(done.exitCode !== null ? { exitCode: done.exitCode } : {}) });
    append(ctx, "step.end", { status: ok ? "ok" : "failed" });
    const status = done.timedOut
      ? `Timed out after ${input.timeout_sec ?? 120} s and was stopped.`
      : done.exitCode === null
        ? `Ended by signal ${done.signal}.`
        : `Exit code ${done.exitCode}.`;
    return {
      ok,
      content: [
        text(
          `${status}${done.truncated ? " Output was cut at 1 MB." : ""}\n${model ? untrusted("command output", tail(model, MODEL_MAX)) : "(no output)"}`,
        ),
      ],
    };
  } catch (error) {
    if (error instanceof ShellCleanupUncertainError)
      return contain(deps, ctx, "shell_cleanup_uncertain");
    if (error instanceof ShellExecutionUncertainError)
      return contain(deps, ctx, "shell_execution_uncertain");
    ctx.check();
    throw error;
  }
}
