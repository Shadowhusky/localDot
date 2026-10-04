import { ulid } from "@localdot/protocol";
import type { CellApi } from "../cells/orchestrator.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import { type ActionGateway, DEFAULT_AGENT, type GuiAction } from "../gateway/gateway.ts";
import type { PuppetScript, PuppetStep } from "./script.ts";

export interface PuppetDeps {
  gateway: ActionGateway;
  eventLog: EventLog;
  registry: DesktopdRegistry;
  cells: CellApi;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface PuppetRun {
  cellId: string;
  sessionId: string;
  script: PuppetScript;
  signal?: AbortSignal;
}

export function actionOf(step: PuppetStep): GuiAction | undefined {
  switch (step.do) {
    case "click":
      return step.find
        ? {
            verb: "click",
            find: step.find,
            button: step.button,
            count: step.count,
            speed: step.speed,
            label: step.label,
          }
        : {
            verb: "click",
            point: { x: step.x as number, y: step.y as number },
            button: step.button,
            count: step.count,
            speed: step.speed,
            label: step.label,
          };
    case "type":
      return {
        verb: "type",
        text: step.text,
        masked: step.masked,
        speed: step.speed,
        label: step.label,
      };
    case "key":
      return { verb: "key", combo: step.combo, speed: step.speed, label: step.label };
    case "scroll":
      return {
        verb: "scroll",
        point: { x: step.x, y: step.y },
        dx: step.dx,
        dy: step.dy,
        speed: step.speed,
        label: step.label,
      };
    case "wait":
      return { verb: "wait", ms: step.ms, label: step.label };
    case "launch":
      return undefined;
  }
}

export async function runPuppet(
  deps: PuppetDeps,
  run: PuppetRun,
): Promise<{ ok: boolean; steps: number }> {
  const { cellId, sessionId, script, signal } = run;
  const cell = deps.cells.get(cellId);
  if (!cell) throw new Error(`unknown cell ${cellId}`);
  const append = (type: string, data: Record<string, unknown>, step?: string) =>
    deps.eventLog.append(sessionId, {
      type,
      agent: DEFAULT_AGENT,
      ...(step ? { step } : {}),
      data,
    } as never);
  append("session.start", {
    screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
    os: "linux",
    title: script.title,
  });
  append("agent.state", { state: "acting" });
  let done = 0;
  let activeStep: string | undefined;
  let reason: "done" | "stopped" | "error" = "done";
  try {
    signal?.throwIfAborted();
    const d = deps.registry.for(cellId);
    if (!d) throw new Error("cell has no desktopd endpoint");
    if (!d.clocks.sample) await d.clocks.sync();
    await deps.gateway.observe({ sessionId, cellId, signal });
    for (const step of script.steps) {
      if (signal?.aborted) {
        reason = "stopped";
        break;
      }
      const id = ulid();
      activeStep = id;
      append("step.start", { kind: "gui" }, id);
      let ok = false;
      if (step.do === "launch") {
        signal?.throwIfAborted();
        if (deps.cells.get(cellId)?.state !== "ready") throw new Error("computer is not ready");
        await d.client.launch({ app: step.app, args: step.args ?? [] }, signal);
        append(
          "action.intent",
          { verb: "wait", label: step.label ?? `Open ${step.app}`, risk: "none" },
          id,
        );
        await deps.sleep(step.waitMs ?? 5000, signal);
        await d.client.settle({});
        await deps.gateway.observe({ sessionId, cellId, step: id, signal });
        append("action.result", { ok: true }, id);
        ok = true;
      } else {
        const action = actionOf(step) as GuiAction;
        const outcome = await deps.gateway.run(
          { sessionId, cellId, step: id, signal, source: "manual" },
          action,
        );
        ok = outcome.ok;
        if (!ok && outcome.cancelled === "user") reason = "stopped";
      }
      append("step.end", { status: ok ? "ok" : signal?.aborted ? "cancelled" : "failed" }, id);
      activeStep = undefined;
      if (!ok) {
        if (reason !== "stopped") reason = "error";
        break;
      }
      done += 1;
    }
  } catch (err) {
    reason = signal?.aborted ? "stopped" : "error";
    if (activeStep)
      append("step.end", { status: reason === "stopped" ? "cancelled" : "failed" }, activeStep);
    if (reason === "error")
      append("agent.state", {
        state: "error",
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
  }
  if (reason === "done") append("agent.state", { state: "done" });
  else if (reason === "stopped") append("agent.state", { state: "idle", reason: "stopped" });
  else append("agent.state", { state: "error", reason: "Task failed" });
  append("session.end", { reason });
  return { ok: reason === "done", steps: done };
}
