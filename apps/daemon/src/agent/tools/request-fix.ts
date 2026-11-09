import type { Blocker, RequestFixInput, ToolResult } from "@localdot/protocol";
import { blockerNote } from "@localdot/protocol/guidance";
import type { OpenBlocker, RaiseOptions } from "../blockers.ts";
import { fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const ASK_WINDOW_MS = 30 * 60_000;
const STILL_OPEN =
  "This isn't fixed yet, and localDot's card stays up. Carry on with what doesn't need it, or end your turn and say what is left: you'll be told once it is fixed. Don't raise it again or ask the user about it.";
export const KEYS_NOT_LOCKED =
  "Saved keys aren't locked, so localDot shows no card. If something still fails, the cause is something else: don't ask the user to unlock anything or for a passphrase.";

export const FIX_TITLES: Record<RequestFixInput["kind"], string> = {
  keys_locked: "Waiting for saved keys to unlock",
  key: "Waiting for a key",
  app: "Waiting for an app to reconnect",
  computer: "Waiting for the computer",
  runtime: "Waiting for Docker",
};

// What is really so, whatever dot was told by a page or a tool: a card only for a blocker that
// exists, named as localDot holds it, and dot's own words go nowhere.
async function realBlocker(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RequestFixInput,
): Promise<Blocker | string> {
  switch (input.kind) {
    case "keys_locked":
      return deps.keysLocked?.() ? { kind: "keys_locked" } : KEYS_NOT_LOCKED;
    case "key": {
      const keys = await deps.credentials?.list();
      ctx.check();
      const key = keys?.find((one) => one.id === input.key_id);
      if (!key)
        return `No saved key is named ${input.key_id}. For a key that doesn't exist yet, use credentials action request.`;
      return {
        kind: "key",
        id: key.id,
        problem: key.rebound ? "rebound" : key.reenter ? "reenter" : "rejected",
      };
    }
    case "app": {
      const app = input.app ? deps.connectors?.ended(input.app) : undefined;
      return app
        ? { kind: "app", ...app }
        : "That app isn't waiting on a sign-in. Use its tools, or credentials action connect for an app not yet connected.";
    }
    case "computer": {
      const state = deps.computerDown?.(ctx.session.cellId);
      return state ? { kind: "computer", state } : "The computer is on.";
    }
    case "runtime": {
      const down = await deps.runtimeDown?.();
      ctx.check();
      return down ? { kind: "runtime" } : "Docker is running.";
    }
  }
}

// dot waits on the card as it would on a question; what ends the wait is the card going.
export async function waitForFix(
  deps: ToolDeps,
  ctx: ToolCallContext,
  blocker: Blocker,
  options: RaiseOptions = { by: "dot" },
): Promise<ToolResult> {
  const open: OpenBlocker | undefined = ctx.session.raiseBlocker(blocker, {
    ...options,
    tell: false,
  });
  if (!open) return { ok: true, content: [text(blockerNote(blocker, "dismissed"))] };
  const ended = await ctx.session.waitForBlocker(
    open,
    deps.askTimeoutMs ?? ctx.session.approvalWindowMs ?? ASK_WINDOW_MS,
    ctx.signal,
  );
  ctx.check();
  switch (ended) {
    case "pause":
      return {
        ok: false,
        pause: true,
        content: [text("The task was paused while waiting for this to be fixed.")],
      };
    case "timeout":
      return { ok: false, content: [text(STILL_OPEN)] };
    case "dismissed":
      return { ok: true, content: [text(blockerNote(blocker, "dismissed"))] };
    case "fixed":
      return { ok: true, content: [text(blockerNote(blocker, "fixed"))] };
  }
}

export async function requestFixTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RequestFixInput,
): Promise<ToolResult> {
  ctx.check();
  const blocker = await realBlocker(deps, ctx, input);
  ctx.check();
  return typeof blocker === "string" ? fail(blocker) : waitForFix(deps, ctx, blocker);
}
