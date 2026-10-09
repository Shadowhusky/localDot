import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import {
  type ActionClass,
  type AgentLimits,
  type ApprovalCard,
  type BootConfig,
  type ComputerAction,
  DEFAULT_AGENT_LIMITS,
  type ManualInput,
  type ModelBinding,
  type TranscriptMessage,
  ulid,
} from "@localdot/protocol";
import { toDevice } from "@localdot/providers";
import type { LanguageModel } from "ai";
import { EventSink } from "../../../../../cells/brain/src/events.ts";
import { Agent, type RunOutcome } from "../../../../../cells/brain/src/loop.ts";
import { ToolClient } from "../../../../../cells/brain/src/tool-client.ts";
import { FakeOrchestrator } from "../../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../../cells/types.ts";
import { monotonicClock } from "../../clock.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { DesktopdTools } from "../../desktopd/tools-client.ts";
import { EventLog } from "../../event-log.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { ActionGateway } from "../../gateway/gateway.ts";
import { loadOnsetTable } from "../../gateway/onset-table.ts";
import { policyFromEnv } from "../../gateway/ring-onset.ts";
import { FramePng } from "../frame-png.ts";
import { sendManualInput } from "../manual-input.ts";
import { MemoryStore } from "../memory.ts";
import { OutputStore } from "../output-store.ts";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { SettingsStore } from "../settings.ts";
import { createToolApi } from "../tool-api.ts";
import type { ToolDeps } from "../tools/deps.ts";
import { TranscriptStore } from "../transcript.ts";
import type { RecordedEvent } from "./analyse.ts";
import type { EvalCell } from "./cell.ts";
import type { DesktopFacts, ScreenWindow } from "./oracle.ts";

export interface ModelUnderTest {
  binding: ModelBinding;
  model: LanguageModel;
  proxy?: BootConfig["proxy"];
}

export interface AgentRunOptions {
  cell: EvalCell;
  home: string;
  task: string;
  model: ModelUnderTest | ((facts: () => DesktopFacts) => ModelUnderTest);
  timeoutMs: number;
  limits?: AgentLimits;
  approvalDelayMs?: number;
  // How the simulated user answers a card, after approvalDelayMs; simulatedAnswer by default.
  answer?: (card: ApprovalCard) => "approve" | "deny";
  // How long a button held between actions stays down without another pointer action.
  heldButtonMs?: number;
}

export interface CallRecord {
  name: string;
  ok: boolean;
  skipped: boolean;
  // The brain refused an action it does not support yet.
  refused: boolean;
}

export interface AgentRun {
  sessionId: string;
  outcome: RunOutcome | "timeout" | "error";
  error?: string;
  wallMs: number;
  events: RecordedEvent[];
  calls: CallRecord[];
  // The model's turns, from the brain's own transcript.
  turns: number;
  assisted: { approvals: number; denied: ActionClass[]; handoffs: number; answers: number };
}

const MODEL_SCREEN = { width: 1280, height: 800 } as const;
const HUMAN_PAUSE_MS = 150;
const DENIED: ReadonlySet<ActionClass> = new Set([
  "purchase",
  "send",
  "post",
  "download_execute",
  "system_settings",
  "credentials",
]);

// The simulated user approves the desktop work a task needs and denies anything that could reach
// past the throwaway desktop: in model mode a real model drives it with open internet.
export const simulatedAnswer = (actionClass: ActionClass): "approve" | "deny" =>
  DENIED.has(actionClass) ? "deny" : "approve";

// What a person does for the input the product handed over: typed text with Return and Tab
// pressed as keys, like someone at the keyboard, rather than as one burst.
export function manualInputsFor(action: ComputerAction | undefined, scale: 1 | 2): ManualInput[] {
  if (action?.action === "type" && action.text)
    return action.text
      .split(/([\n\t])/)
      .filter(Boolean)
      .map(
        (part): ManualInput =>
          part === "\n"
            ? { kind: "key", combo: ["Return"] }
            : part === "\t"
              ? { kind: "key", combo: ["Tab"] }
              : { kind: "text", text: part },
      );
  const keys = action?.action === "key" ? action.keys : undefined;
  if (keys)
    return Array.from(
      { length: action?.repeat ?? 1 },
      (): ManualInput => ({ kind: "key", combo: keys }),
    );
  if (action?.action === "click" && action.point)
    return [
      {
        kind: "click",
        at: toDevice(action.point, { ...MODEL_SCREEN, scale }),
        button: action.button ?? "left",
        count: action.count ?? 1,
      },
    ];
  return [];
}

// Every tool call the model made, from the brain's own transcript: failures include calls the
// brain refused itself, and calls it skipped after an earlier failure in the batch are kept apart.
export function callsOf(transcript: readonly TranscriptMessage[]): CallRecord[] {
  return transcript.flatMap((message) =>
    message.role !== "tool" || !Array.isArray(message.content)
      ? []
      : (
          message.content as {
            type?: string;
            toolName?: string;
            output?: { type: string; value: unknown };
          }[]
        )
          .filter((part) => part.type === "tool-result")
          .map((part) => {
            const output = part.output ?? { type: "text", value: "" };
            const ok = !output.type.startsWith("error");
            const text = typeof output.value === "string" ? output.value : "";
            return {
              name: part.toolName ?? "",
              ok,
              skipped: !ok && text.startsWith("Skipped:"),
              refused: !ok && /\bnot supported yet\b/.test(text),
            };
          }),
  );
}

// Every answer the model gave. The event log can miss the last one: the brain's usage event for
// the turn that called done can arrive after the task closed.
export function turnsOf(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((message) => message.role === "assistant").length;
}

// One task on one desktop through the product's own path: the brain loop (in process, with the
// given model) calls the daemon's tool API over HTTP, whose handlers authorize under the eval
// home's autonomy policy and drive the action gateway, desktopd and the real apps in the cell.
// A simulated user answers what a person would: it answers every card (simulatedAnswer), and when
// the product hands the screen over, it does the pending input itself and hands control back.
export async function runAgent(o: AgentRunOptions): Promise<AgentRun> {
  const clock = monotonicClock();
  const eventLog = new EventLog(o.home, clock);
  const autonomy = new SettingsStore(o.home).get().autonomy;
  const sessionId = eventLog.createSession(o.task.slice(0, 200));
  const cellId = ulid();
  const cells = new FakeOrchestrator();
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: o.cell.baseUrl, token: o.cell.token },
    stream: { baseUrl: "http://127.0.0.1:9", authorization: "Basic eval" },
  });
  cells.emit({
    id: cellId,
    state: "ready",
    scale: o.cell.scale,
    createdAt: new Date().toISOString(),
    stream: NO_STREAM,
  });
  let windows: ScreenWindow[] = [];
  const tap: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok && String(input).endsWith("/observe")) {
      const body = (await response.clone().json()) as {
        windows?: { cls: string; title: string; rect: ScreenWindow["rect"] }[];
      };
      const s = o.cell.scale;
      windows = (body.windows ?? []).map((w) => ({
        cls: w.cls,
        title: w.title,
        rect: { x: w.rect.x / s, y: w.rect.y / s, w: w.rect.w / s, h: w.rect.h / s },
      }));
    }
    return response;
  };
  const registry = new DesktopdRegistry(cells, clock, tap);
  const frames = new FrameStore(o.home);
  const onset = loadOnsetTable(o.home);
  const gateway = new ActionGateway({
    eventLog,
    cells,
    registry,
    onset,
    ringOnset: policyFromEnv(onset),
    frames,
    now: () => clock.nowMicros(),
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
    ...(o.heldButtonMs ? { heldButtonMs: o.heldButtonMs } : {}),
  });
  const session = new AgentSession(sessionId, cellId, o.task, eventLog, autonomy);
  session.append("session.start", {
    screen: { w: 1280 * o.cell.scale, h: 800 * o.cell.scale, scale: o.cell.scale },
    os: "linux",
    title: o.task.slice(0, 200),
  });
  session.append("message.user", { messageId: ulid(), text: o.task, kind: "task" });
  const desktop = new DesktopdTools({ baseUrl: o.cell.baseUrl, token: o.cell.token });
  const png = new FramePng(frames, gateway);
  const outputs = new OutputStore(o.home);
  const tools: ToolDeps = {
    gateway,
    scaleOf: () => o.cell.scale,
    desktop: () => desktop,
    launcher: () => registry.for(cellId)?.client,
    png,
    memory: new MemoryStore(o.home),
    saveOutput: (id, name, source, scope) => outputs.save(id, name, source, scope),
    stopForUncertainty: async () => {},
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
  };
  const toolToken = randomBytes(32).toString("base64url");
  const transcripts = new TranscriptStore(o.home);
  const app = createToolApi({
    tools,
    sessions: () => [session],
    transcripts,
    png,
    redactorFor: () => redactor([toolToken, o.cell.token]),
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", () => resolve()),
  );
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const assisted: AgentRun["assisted"] = { approvals: 0, denied: [], handoffs: 0, answers: 0 };
  const mut =
    typeof o.model === "function"
      ? o.model(() => ({ windows, handoffs: assisted.handoffs }))
      : o.model;
  const boot: BootConfig = {
    sessionId,
    task: o.task,
    models: { main: mut.binding },
    proxy: mut.proxy ?? { url: "http://127.0.0.1:9", token: "p".repeat(43) },
    memory: { user: "", memory: "" },
    skills: [],
    limits: o.limits ?? DEFAULT_AGENT_LIMITS,
    resume: false,
    inboxAfter: 0,
  };
  const generation = session.beginBrain();
  session.publishBrain(generation, { toolToken, boot, brainCellId: ulid() });
  session.setStatus("running");

  const abort = new AbortController();
  let pendingComputer: ComputerAction | undefined;
  const userWork: Promise<unknown>[] = [];
  const completeHandoff = async (requestId: string) => {
    for (const input of manualInputsFor(pendingComputer, o.cell.scale)) {
      const device = registry.for(cellId);
      if (!device) throw new Error("the desktop is unavailable");
      await sendManualInput(session, { requestId, input }, abort.signal, (_s, scope) => ({
        screen: { w: 1280 * o.cell.scale, h: 800 * o.cell.scale },
        client: device.client,
        check: () => scope.check(),
        prepare: async () => {
          if (!device.clocks.sample) await device.clocks.sync();
        },
        release: () => {},
      }));
      await sleep(HUMAN_PAUSE_MS);
    }
    if (!(await session.handback(requestId, undefined, abort.signal)))
      throw new Error("the hand-back was refused");
    assisted.handoffs += 1;
  };
  const unsubscribe = eventLog.subscribe((id, event) => {
    if (id !== sessionId) return;
    const data = event.data as Record<string, unknown>;
    if (event.type === "approval.request")
      setTimeout(() => {
        const card = session.pendingApproval;
        if (!card || card.approvalId !== data.approvalId) return;
        const decision = o.answer?.(card) ?? simulatedAnswer(card.actionClass);
        if (
          !session.answerApproval({
            approvalId: card.approvalId,
            generation: card.generation,
            revision: card.revision,
            decision,
          })
        )
          return;
        if (decision === "approve") assisted.approvals += 1;
        else assisted.denied.push(card.actionClass);
      }, o.approvalDelayMs ?? 0);
    else if (event.type === "takeover.request")
      // The control record is marked held right after this event is written.
      userWork.push(
        sleep(0)
          .then(() => completeHandoff(String(data.requestId)))
          .catch((error) => {
            abort.abort(error);
          }),
      );
    else if (event.type === "ask.request")
      setTimeout(() => {
        const askId = String(data.askId);
        // Nothing here can fill in a form: a question with fields is declined.
        if (data.fields ? session.decline(askId) : session.answer(askId, "A", undefined))
          assisted.answers += 1;
      }, 0);
    else if (event.type === "safety.pause" && !abort.signal.aborted)
      abort.abort(new Error("the repeat guard paused the task"));
    else if (event.type === "agent.state" && data.state === "paused" && data.reason === "budget")
      abort.abort(new Error("the spend cap was reached"));
  });

  const api = new ToolClient(apiUrl, toolToken);
  const tracked = {
    tool: (name: string, callId: string, input: unknown, signal?: AbortSignal) => {
      if (name === "computer") pendingComputer = input as ComputerAction;
      return api.tool(name, callId, input, signal);
    },
    inbox: api.inbox.bind(api),
    appendTranscript: api.appendTranscript.bind(api),
    control: api.control.bind(api),
  };
  const sink = new EventSink({ send: (events, signal) => api.events(events, signal) });
  const started = performance.now();
  const timer = setTimeout(() => abort.abort(new Error("timeout")), o.timeoutMs);
  let outcome: AgentRun["outcome"];
  let error: string | undefined;
  try {
    const agent = new Agent({
      boot: await api.boot(abort.signal),
      api: tracked,
      sink,
      models: { main: mut.model },
      history: [],
    });
    outcome = await agent.run(abort.signal);
    if (outcome === "stopped" && abort.signal.aborted) {
      const reason = abort.signal.reason;
      error = reason instanceof Error ? reason.message : String(reason);
      outcome = error === "timeout" ? "timeout" : "error";
    }
  } catch (caught) {
    outcome = "error";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = performance.now() - started;
  abort.abort();
  await Promise.allSettled(userWork);
  unsubscribe();
  await sink.close().catch(() => {});
  session.stop();
  await Promise.allSettled([api.close(), desktop.close(), session.toolsSettled()]);
  registry.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const events = eventLog.read(sessionId) as unknown as RecordedEvent[];
  const transcript = transcripts.read(sessionId);
  eventLog.close();
  return {
    sessionId,
    outcome,
    ...(error ? { error } : {}),
    wallMs,
    events,
    calls: callsOf(transcript),
    turns: turnsOf(transcript),
    assisted,
  };
}
