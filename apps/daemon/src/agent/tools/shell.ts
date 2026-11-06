import { randomUUID } from "node:crypto";
import { clipText, type InboxItem, type ShellInput, type ToolResult } from "@localdot/protocol";
import {
  describeShellDiagnosis,
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "../../desktopd/tools-client.ts";
import {
  beginFileTracking,
  creationCandidates,
  finishFileTracking,
} from "../safety/local-cleanup.ts";
import type { ToolLease, UserSteering } from "../session.ts";
import { untrusted } from "../untrusted.ts";
import {
  append,
  contain,
  fail,
  hearsUser,
  intentOf,
  listenForUser,
  type ToolCallContext,
  type ToolDeps,
  text,
  woken,
} from "./deps.ts";

// The model sees a long output's start and its end: a build's first error and its summary.
const LOG_MAX = 256 * 1024,
  MODEL_HEAD = 4 * 1024,
  MODEL_TAIL = 12 * 1024,
  FLUSH = 8 * 1024;
// A message that comes this close to the end of a command's opening sleep lets the command go on.
const SLEEP_MARGIN_MS = 1000;
// After the user's message, how long a command that isn't a wait has to end by itself before dot
// leaves it running. Most end before the difference would show.
const LEAVE_AFTER_MS = 3000;
// What a command left running can say when it ends: a message's room, less the lines around it.
const NOTE_HEAD = 1500,
  NOTE_TAIL = 5500,
  NOTE_MAX = 8000;
const WORD = String.raw`[^\s;&|<>()$\`"'\\#]+`;
// `cd`, `export` and assignments, which run at once, then `;`, `&&` or a new line.
const SETUP = new RegExp(
  String.raw`^\s*(?:(?:cd|export)(?:[ \t]+${WORD})+|[A-Za-z_][A-Za-z0-9_]*=${WORD}?)[ \t]*(?:;|&&|\n)`,
);
const SLEEP = /^\s*sleep[ \t]+(\d+(?:\.\d+)?)([smh]?)[ \t]*(?:;|&&|\n|$)/;
const UNIT = { "": 1000, s: 1000, m: 60_000, h: 3_600_000 } as const;

// How long a command sleeps before anything else in it runs, as in `sleep 90; echo waited` or
// `cd app && sleep 30 && curl …`; undefined when it doesn't start with a plain sleep.
export function openingSleepMs(command: string): number | undefined {
  let rest = command;
  for (let setup = SETUP.exec(rest); setup; setup = SETUP.exec(rest))
    rest = rest.slice(setup[0].length);
  const sleep = SLEEP.exec(rest);
  if (!sleep?.[1]) return undefined;
  return Math.round(Number(sleep[1]) * UNIT[(sleep[2] ?? "") as keyof typeof UNIT]);
}
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
    const command = ctx.localCleanup?.command ?? input.command;
    // Only a command's opening sleep ends for the user: nothing else has run by then, and nothing
    // after it will once the command is stopped. Any other command goes on, and dot leaves it
    // running to read what they said.
    const sleepMs = openingSleepMs(command);
    const listening =
      sleepMs !== undefined && sleepMs > SLEEP_MARGIN_MS
        ? listenForUser(ctx, ctx.signal, sleepMs)
        : undefined;
    if (listening?.spoke) {
      append(ctx, "tool.end", { ok: false });
      append(ctx, "step.end", { status: "cancelled" });
      return fail(
        "Not run: the user sent a new message before this command began. Read it, then decide whether to run it.",
      );
    }
    const steered = Promise.withResolvers<InboxItem>();
    let steering: UserSteering | undefined;
    const heed = () => {
      if (!hearsUser(ctx)) return;
      steering = ctx.session.whenUserSteers(ctx.signal);
      void steering.said.then(steered.resolve);
    };
    const started = performance.now();
    const closing = listening
      ? setTimeout(
          () => {
            listening.end();
            if (!listening.spoke) heed();
          },
          (sleepMs ?? 0) - SLEEP_MARGIN_MS,
        )
      : undefined;
    if (!listening) heed();
    // Stopping goes through this one signal, so that a command left running answers to its own
    // lease once the call that started it has been answered.
    const stopper = new AbortController();
    let unbind = stopWith(listening?.signal ?? ctx.signal, stopper);
    // Windows the command's programs open are this task's.
    const id = randomUUID();
    deps.computer?.owners(ctx.session.cellId).shell(id, ctx.session.id);
    const modelOutput = () =>
      seen <= MODEL_HEAD + MODEL_TAIL
        ? whole
        : `${head}\n… (${seen - Buffer.byteLength(head) - Buffer.byteLength(end)} bytes cut from the middle) …\n${end}`;
    const finished = (async (): Promise<ToolResult> => {
      try {
        let done: Awaited<ReturnType<typeof desktop.shell>>;
        try {
          done = await desktop.shell(
            {
              id,
              task: ctx.session.id,
              command,
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
            stopper.signal,
          );
        } finally {
          clearTimeout(closing);
          listening?.end();
          steering?.end();
        }
        ctx.check();
        if (listening?.spoke) {
          const slept = Math.round((performance.now() - started) / 1000);
          append(ctx, "tool.end", { ok: false });
          append(ctx, "step.end", { status: "cancelled" });
          return {
            ok: true,
            content: [
              text(
                `${woken(listening)} The command was stopped ${slept} s into its opening ${Math.round((sleepMs ?? 0) / 1000)} s sleep, before anything after the sleep ran. Read the message, then decide whether to run the rest.`,
              ),
            ],
          };
        }
        if (redaction) {
          for (const part of redaction.finish()) consume(part.chunk, part.stream);
        } else consume(ctx.redact(rawFallback), "stdout");
        flush();
        const model = modelOutput();
        ctx.session.tainted = true;
        if (model) ctx.session.taint.add("files", "command output", model);
        ctx.session.connections.checkedThroughProxy(input.command);
        const ok = done.exitCode === 0 && !done.timedOut;
        if (ok) await finishFileTracking(deps, ctx, tracking);
        append(ctx, "tool.end", {
          ok,
          ...(done.exitCode !== null ? { exitCode: done.exitCode } : {}),
        });
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
        if (error instanceof ShellCleanupUncertainError) {
          held(ctx, "the command's processes could not be confirmed ended");
          return contain(deps, ctx, "shell_cleanup_uncertain");
        }
        if (error instanceof ShellExecutionUncertainError) {
          const why = error.diagnosis && describeShellDiagnosis(error.diagnosis);
          held(ctx, `the command's end could not be confirmed${why ? ` (${why})` : ""}`);
          return contain(deps, ctx, "shell_execution_uncertain", why);
        }
        ctx.check();
        throw error;
      }
    })();
    const said = await Promise.race([finished.then(() => undefined), steered.promise]);
    if (!said) return await finished;
    // A command about to end says so itself.
    const leaving = await Promise.race([
      finished.then(() => false),
      deps.sleep(LEAVE_AFTER_MS, ctx.signal).then(
        () => !ctx.signal.aborted,
        () => false,
      ),
    ]);
    if (!leaving) return await finished;
    let lease: ToolLease;
    try {
      lease = ctx.session.leaveRunning(ctx.generation, said);
    } catch {
      return await finished;
    }
    unbind();
    unbind = stopWith(lease.signal, stopper);
    ctx.lease = lease;
    ctx.signal = lease.signal;
    ctx.check = () => lease.check();
    const title = clipText(ctx.redact(input.command), 120);
    void finished
      .then(
        (result) => endedNote(title, result),
        (error) => {
          if (ctx.session.stopped) return undefined;
          // A failure the call would have reported itself, had it still been waiting.
          const message = ctx.redact(error instanceof Error ? error.message : String(error));
          if (!ctx.signal.aborted && !ctx.session.controlHeld) {
            append(ctx, "tool.end", { ok: false });
            append(ctx, "step.end", { status: "failed", note: clipText(message, 500) });
          }
          return `(localDot: the command you left running, ${title}, ended before localDot could tell how it went: ${clipText(message, 500)})`;
        },
      )
      .then((note) => {
        if (note) ctx.session.remind(ctx.redact(note).slice(0, NOTE_MAX).toWellFormed());
      })
      .catch(() => {})
      .finally(() => {
        unbind();
        ctx.session.commandEnded(lease);
      });
    const soFar = modelOutput();
    if (soFar) ctx.session.taint.add("files", "command output", soFar);
    return {
      ok: true,
      content: [
        text(
          `The user sent a new message, so this command goes on in the background. It has not finished and may still be changing things: don't start it again, and don't treat its work as done. localDot tells you when it ends, with its exit code and output. Read the message now.\n${soFar ? `Its output so far:\n${untrusted("command output", soFar)}` : "It has printed nothing so far."}`,
        ),
      ],
    };
  } catch (error) {
    ctx.check();
    throw error;
  }
}

function stopWith(signal: AbortSignal, stopper: AbortController): () => void {
  const stop = () => stopper.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return () => signal.removeEventListener("abort", stop);
}

// What dot hears when a command it left running has ended: the result the call would have given,
// with the middle of its output cut to fit a message.
function endedNote(title: string, result: ToolResult): string | undefined {
  if (result.final) return undefined;
  const said = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const kept =
    said.length <= NOTE_HEAD + NOTE_TAIL
      ? said
      : `${said.slice(0, NOTE_HEAD)}\n… (cut from the middle) …\n${said.slice(-NOTE_TAIL)}`;
  return `(localDot: the command you left running has ended: ${title}.)\n${kept}`;
}

// The step says why the computer is held, whether or not the task was already stopped.
function held(ctx: ToolCallContext, why: string): void {
  try {
    ctx.session.append("tool.end", { ok: false }, ctx.step);
    ctx.session.append(
      "step.end",
      {
        status: "failed",
        note: clipText(ctx.redact(`Stopped: ${why}. The computer is held for recovery.`), 500),
      },
      ctx.step,
    );
  } catch {
    /* Containment goes ahead whether or not the journal takes the note. */
  }
}
