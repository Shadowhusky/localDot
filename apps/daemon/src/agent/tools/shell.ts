import { randomUUID } from "node:crypto";
import type { ShellInput, ToolResult } from "@localdot/protocol";
import {
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "../../desktopd/tools-client.ts";
import {
  beginFileTracking,
  creationCandidates,
  finishFileTracking,
} from "../safety/local-cleanup.ts";
import { untrusted } from "../untrusted.ts";
import {
  append,
  contain,
  fail,
  intentOf,
  type ToolCallContext,
  type ToolDeps,
  text,
} from "./deps.ts";

// The model sees a long output's start and its end: a build's first error and its summary.
const LOG_MAX = 256 * 1024,
  MODEL_HEAD = 4 * 1024,
  MODEL_TAIL = 12 * 1024,
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
    seen = 0,
    whole = "",
    head = "",
    end = "",
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
    seen += Buffer.byteLength(safe);
    if (Buffer.byteLength(head) < MODEL_HEAD) head = prefix(head + safe, MODEL_HEAD);
    end = last(end + safe, MODEL_TAIL);
    whole = seen <= MODEL_HEAD + MODEL_TAIL ? whole + safe : "";
    if (logged < LOG_MAX) pending = prefix(pending + safe, LOG_MAX - logged);
    if (pending.length >= FLUSH || Date.now() - lastFlush >= 100) flush();
  };
  try {
    const candidates = creationCandidates(input);
    const tracking = await beginFileTracking(
      deps,
      ctx,
      candidates.paths,
      candidates.prefix,
      input.cwd,
    );
    // Windows the command's programs open are this task's.
    const id = randomUUID();
    deps.computer?.owners(ctx.session.cellId).shell(id, ctx.session.id);
    const done = await desktop.shell(
      {
        id,
        command: ctx.localCleanup?.command ?? input.command,
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
    const model =
      seen <= MODEL_HEAD + MODEL_TAIL
        ? whole
        : `${head}\n… (${seen - Buffer.byteLength(head) - Buffer.byteLength(end)} bytes cut from the middle) …\n${end}`;
    ctx.session.tainted = true;
    if (model) ctx.session.taint.add("files", "command output", model);
    ctx.session.connections.checkedThroughProxy(input.command);
    const ok = done.exitCode === 0 && !done.timedOut;
    if (ok) await finishFileTracking(deps, ctx, tracking);
    append(ctx, "tool.end", { ok, ...(done.exitCode !== null ? { exitCode: done.exitCode } : {}) });
    append(ctx, "step.end", { status: ok ? "ok" : "failed" });
    const resourceWarning =
      (done.oomKillsDuringCommand ?? 0) > 0
        ? `\nMemory limit reached: the desktop kernel killed ${done.oomKillsDuringCommand} process(es) during this command, possibly a browser renderer even if the command succeeded. Inspect work_context, reduce competing build/preview jobs and worker counts before retrying the page. Do not reset its profile or request passwords again.`
        : done.memory && done.memory.pressure !== "normal"
          ? `\nDesktop memory pressure is ${done.memory.pressure}: ${Math.round(done.memory.workingSetBytes / 1024 ** 2)} MiB working set of ${Math.round(done.memory.limitBytes / 1024 ** 2)} MiB. Reuse existing servers, limit parallel workers, and stop only your own unnecessary jobs before starting more work.`
          : "";
    const status = done.timedOut
      ? `Timed out after ${input.timeout_sec ?? 120} s and was stopped.`
      : done.exitCode === null
        ? `Ended by signal ${done.signal}.`
        : `Exit code ${done.exitCode}.`;
    return {
      ok,
      ...(done.timedOut
        ? {
            recovery: {
              kind: "timeout" as const,
              surface: "desktop" as const,
              retry: "verify_first" as const,
            },
          }
        : {}),
      content: [
        text(
          `${status}${done.outputIncomplete ? " Connection interrupted; completion was independently verified. Some output may be missing. Inspect the resulting files or service state before continuing; do not rerun blindly." : ""}${resourceWarning}${done.truncated ? " Output was cut at 1 MB." : ""}\n${model ? untrusted("command output", model) : "(no output)"}`,
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
