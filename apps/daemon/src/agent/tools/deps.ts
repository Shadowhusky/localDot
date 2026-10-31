import { clipText, INTENT_CHARS, type ToolResult } from "@localdot/protocol";
import type { ScreenLease } from "../../browser/screen-controller.ts";
import type { ConnectorHub } from "../../connectors/hub.ts";
import type { DesktopdClient } from "../../desktopd/client.ts";
import type { NativeDevice } from "../../desktopd/registry.ts";
import type { DesktopdTools } from "../../desktopd/tools-client.ts";
import type { ActionContext, ActionGateway, NativeScreenBinding } from "../../gateway/gateway.ts";
import type { ComputerTurn, ComputerTurns } from "../computer-turn.ts";
import type { FramePng } from "../frame-png.ts";
import type { MemoryStore } from "../memory.ts";
import type { PeopleStore } from "../people.ts";
import type { Redactor } from "../redact.ts";
import type { EffectPermit } from "../safety/authorize.ts";
import { screenOf } from "../safety/autonomy.ts";
import type { AgentSession, BrainGeneration, ToolLease, UserListener } from "../session.ts";
import type { Transfers } from "../transfers.ts";
import type { WebAccess } from "../web/cell.ts";

export interface RecallHit {
  sessionId?: string;
  context?: string;
  title: string;
  day: string;
  kind: "title" | "user" | "assistant" | "summary" | "step" | "file" | "note";
  snippet: string;
}

export interface ToolDeps {
  hideWork?(id: string): Promise<void>;
  recallExperience?(query: string, excludeSessionId: string): string;
  saveExperience?(
    id: string,
    experience: import("../../../../../packages/protocol/src/experience.ts").LearnedExperience,
  ): boolean;
  uploads?: {
    desktop(cellId: string): Pick<DesktopdTools, "inspectUpload" | "readUpload"> | undefined;
    transfers: Pick<Transfers, "acquire">;
  };
  gateway: Pick<ActionGateway, "run" | "observe" | "cursorOf"> &
    Partial<Pick<ActionGateway, "find">>;
  // Turns on the computer, one action at a time across the tasks sharing it.
  computer?: Pick<ComputerTurns, "take" | "owners" | "busy">;
  // Installed with the session's screen controller; one private binding per admitted tool.
  bindScreen?(session: AgentSession, lease: ScreenLease): NativeScreenBinding;
  // The cell's scale, to bring the gateway's device-pixel cursor back to model pixels.
  scaleOf(cellId: string): 1 | 2 | undefined;
  desktop(
    cellId: string,
  ):
    | (Pick<
        DesktopdTools,
        | "shell"
        | "readFile"
        | "writeFile"
        | "editFile"
        | "listDir"
        | "fetchFile"
        | "browserRead"
        | "browserNavigate"
      > &
        Partial<Pick<DesktopdTools, "elements" | "capabilities" | "putFile">>)
    | undefined;
  launcher(
    cellId: string,
  ): (Pick<DesktopdClient, "launch"> & Partial<Pick<DesktopdClient, "windowControl">>) | undefined;
  // The desktop's input device while its computer takes input: where a secret answer is typed
  // when the session has no screen controller.
  device?(cellId: string): NativeDevice | undefined;
  png: Pick<FramePng, "png"> & Partial<Pick<FramePng, "same">>;
  memory: Pick<MemoryStore, "apply" | "appendNote">;
  // Redacted history matching a query, including messages compacted out of the current task.
  recall?(query: string, limit: number, excludeSessionId: string): RecallHit[];
  people?: Pick<PeopleStore, "find" | "record" | "redirects">;
  // Where a done task's files are kept for the result card: <home>/sessions/<id>/out/<name>.
  saveOutput(
    sessionId: string,
    name: string,
    source: ReadableStream<Uint8Array>,
    scope: { signal: AbortSignal; check(): void },
  ): Promise<{ path: string; bytes: number; version?: number }>;
  // Called after synchronous session.stop(); must still revoke/freeze already-fenced sessions.
  stopForUncertainty(
    session: AgentSession,
    reason: "shell_cleanup_uncertain" | "shell_execution_uncertain" | "memory_write_uncertain",
  ): Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  askTimeoutMs?: number;
  logins?: {
    login(origin: string): Promise<{ username: string; password: string } | undefined>;
    saveLogin(origin: string, username: string, password: string): Promise<void>;
  };
  routines?: import("./routine.ts").RoutineToolPort;
  connectors?: Pick<ConnectorHub, "access" | "check" | "call" | "observation">;
  // The web tools' own way out, through keyd, without the screen or the user's sign-ins.
  web?: WebAccess;
  credentials?: Pick<import("../../keyd/service-keys.ts").ServiceKeys, "list" | "request">;
}

export interface ToolCallContext {
  session: AgentSession;
  generation: BrainGeneration;
  lease: ToolLease;
  check(): void;
  callId: string;
  step: string;
  redact: Redactor;
  signal: AbortSignal;
  permit?: EffectPermit;
  localCleanup?: import("../safety/local-cleanup.ts").LocalCleanup;
  screen?: ScreenLease;
  nativeScreen?: NativeScreenBinding;
  turn?: ComputerTurn;
  // The call's last Activity step was stopped before it did anything.
  stepCancelled?: boolean;
}

export function text(t: string): ToolResult["content"][number] {
  return { type: "text", text: t };
}

export function screenContext(ctx: ToolCallContext): ActionContext {
  ctx.check();
  if (ctx.session.screens && (!ctx.screen || !ctx.nativeScreen))
    throw new Error("The selected screen is unavailable.");
  return {
    sessionId: ctx.session.id,
    cellId: ctx.nativeScreen?.cellId ?? ctx.session.cellId,
    step: ctx.step,
    signal: ctx.signal,
    ...(ctx.nativeScreen ? { screen: ctx.nativeScreen } : {}),
    // Other tasks' windows are on the desktop; the web browser works for one task at a time.
    ...(ctx.turn && ctx.screen?.selection.screen !== "browser"
      ? { foreign: ctx.turn.foreign, hidden: ctx.turn.hidden }
      : {}),
  };
}

export function fail(message: string): ToolResult {
  return { ok: false, content: [text(message)] };
}

// What dot hears when the user's message ends one of its waits; the message itself follows.
export const USER_SPOKE = "Stopped waiting early: the user sent a new message.";
// A wait of dot's that the user's new message ends early. The brain's delegated agents (their
// calls are named `sub-…`) don't hear the user, so their waits run their course.
export function listenForUser(ctx: ToolCallContext, signal = ctx.signal): UserListener {
  return ctx.callId.startsWith("sub-")
    ? { signal, spoke: false, end: () => {} }
    : ctx.session.listenForUser(signal);
}

// The tail of long output: the end of a log is where the error usually is.
export function tail(s: string, max: number): string {
  return s.length <= max ? s : `… (${s.length - max} earlier characters cut)\n${s.slice(-max)}`;
}

// Cuts by code points, keeping newlines (clipText would fold a summary onto one line).
export function cut(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

// The call's line for the user, as plain text: secrets masked first, since a mask can be longer
// than what it hides, then cut to the event's limit.
export function intentOf(ctx: ToolCallContext, input: { intent?: string }): { intent?: string } {
  const line = input.intent ? clipText(ctx.redact(input.intent), INTENT_CHARS) : "";
  return line ? { intent: line } : {};
}

export function append(ctx: ToolCallContext, kind: string, data: Record<string, unknown>): void {
  ctx.check();
  const redact = (v: unknown): unknown =>
    typeof v === "string"
      ? ctx.redact(v)
      : Array.isArray(v)
        ? v.map(redact)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
          : v;
  ctx.session.append(kind, redact(data) as Record<string, unknown>, ctx.step);
}
export async function contain(
  deps: ToolDeps,
  ctx: ToolCallContext,
  reason: Parameters<ToolDeps["stopForUncertainty"]>[1],
): Promise<ToolResult> {
  ctx.session.stop();
  try {
    await deps.stopForUncertainty(ctx.session, reason);
  } catch {
    /* Access stays fenced even when containment fails. */
  }
  return {
    ok: false,
    final: true,
    content: [
      text(
        "The task was stopped because completion or cleanup could not be confirmed. Do not retry this operation.",
      ),
    ],
  };
}
export function taintScreen(ctx: ToolCallContext, host?: string, text?: string): void {
  ctx.session.taintScreen(screenOf(ctx), host, text);
}
export async function frame(
  deps: ToolDeps,
  ctx: ToolCallContext,
  frameId: string,
  region?: { x: number; y: number; w: number; h: number },
): Promise<ToolResult["content"][number]> {
  ctx.check();
  const png = await deps.png.png(ctx.session.id, frameId, region, ctx.signal);
  ctx.check();
  ctx.session.tainted = true;
  taintScreen(ctx);
  if (!region) ctx.session.lastFrameId = frameId;
  return {
    type: "image",
    frameId,
    ...(region ? { region } : {}),
    mediaType: "image/png",
    data: png.toString("base64"),
  };
}
