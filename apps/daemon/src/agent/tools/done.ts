import { basename } from "node:path";
import type { DoneInput, ToolResult } from "@localdot/protocol";
import { PausedStepError } from "../safety/step-barrier.ts";
import { abortable } from "../session.ts";
import { append, cut, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
export async function doneTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: DoneInput,
): Promise<ToolResult> {
  ctx.check();
  // Normal dispatch routes this to ask_user before policy checks. Direct callers must not
  // turn an unresolved input request into a finished result or collect files prematurely.
  if (input.input_request)
    return fail("This task needs the user's input. Ask with ask_user, then continue the work.");
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const completion = input.completion;
  if (completion?.status === "waiting") {
    // Waiting on another actor or a process is still part of this task. Keep it
    // cancellable under the normal tool lease without requiring a live screen,
    // collecting files, recording a result, or saving an unfinished lesson.
    const ms = (completion.wait_seconds ?? 15) * 1000;
    append(ctx, "step.start", { kind: "think", intent: cut(ctx.redact(completion.evidence), 120) });
    append(ctx, "tool.start", { tool: "done", title: "Waiting for progress" });
    const requests = ctx.session.requests.length;
    let waited = 0;
    while (waited < ms && ctx.session.requests.length === requests) {
      if (ctx.session.safetyPause) throw new PausedStepError();
      const interval = Math.min(1000, ms - waited);
      await abortable(deps.sleep(interval, ctx.signal), ctx.signal);
      ctx.check();
      waited += interval;
    }
    if (ctx.session.safetyPause) throw new PausedStepError();
    append(ctx, "tool.end", { ok: true });
    append(ctx, "step.end", { status: "ok" });
    return {
      ok: true,
      content: [
        text(
          ctx.session.requests.length !== requests
            ? "A new user instruction arrived. The task remains active; apply that instruction before continuing."
            : `Waited ${waited / 1000} seconds. The task remains active and unfinished. Inspect the current state, act when the next step is available, and keep waiting when needed until the user's requested outcome is verified. Another actor's turn or a pending process is not task completion.`,
        ),
      ],
    };
  }
  const desktop = deps.desktop(ctx.session.cellId);
  const files: { name: string; path: string; bytes: number; version?: number }[] = [];
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
      files.push({
        name: ctx.redact(name),
        path: ctx.redact(path),
        bytes: saved.bytes,
        ...(saved.version === undefined ? {} : { version: saved.version }),
      });
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
  const checked = input.checked?.trim() || completion?.evidence.trim();
  if (checked && completion?.status !== "blocked")
    append(ctx, "step.verify", { status: "success", evidence: cut(ctx.redact(checked), 200) });
  if (input.experience && deps.saveExperience) {
    const experience = input.experience;
    deps.saveExperience(ctx.session.id, {
      scope: ctx.redact(experience.scope),
      when: ctx.redact(experience.when),
      procedure: ctx.redact(experience.procedure),
      recheck: ctx.redact(experience.recheck),
      ...(experience.outcome ? { outcome: experience.outcome } : {}),
      ...(experience.cues ? { cues: experience.cues.map((cue) => ctx.redact(cue)) } : {}),
    });
  }
  append(ctx, "task.result", {
    summary: cut(ctx.redact(input.summary), 8000),
    files,
    ...(completion ? { outcome: completion.status } : {}),
  });
  return {
    ok: true,
    final: true,
    content: [
      text(
        completion?.status === "blocked" ? "Task ended with unfinished work." : "Task finished.",
      ),
    ],
  };
}
