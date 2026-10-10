import type { AgentModel, AgentStep } from "../agent/model.ts";
import { appendTerminal, emptyTerminal, terminalDisplayed } from "../agent/terminal-text.ts";

export const WORK_LAYOUT_KEY = "localdot.work-overlay.v1";
export interface WorkLayout {
  x: number;
  y: number;
  minimized: boolean;
  hidden: boolean;
}
export function readWorkLayout(): WorkLayout {
  const fallback = {
    hidden: false,
    x: 0.02,
    y: window.innerWidth < 700 ? 0.48 : 0.78,
    minimized: window.innerWidth < 700,
  };
  try {
    const value = JSON.parse(localStorage.getItem(WORK_LAYOUT_KEY) ?? "null");
    return {
      hidden: value?.hidden === true,
      x: Number.isFinite(value?.x) ? Math.max(0, Math.min(1, value.x)) : fallback.x,
      y: Number.isFinite(value?.y) ? Math.max(0, Math.min(1, value.y)) : fallback.y,
      minimized: typeof value?.minimized === "boolean" ? value.minimized : fallback.minimized,
    };
  } catch {
    return fallback;
  }
}
export const backgroundStep = (step: AgentStep) =>
  ["shell", "file", "app"].includes(step.kind ?? "") ||
  (step.kind === "browser" && ["web_search", "web_fetch"].includes(step.tool?.name ?? ""));

// A bounded view of the existing redacted feed. Nothing is sent to the computer or replay.
export function workTranscript(model: Pick<AgentModel, "steps" | "changes">) {
  const all = [...model.steps.values()];
  const steps = all.filter(backgroundStep).slice(-6);
  let budget = 12000;
  const entries = steps
    .reverse()
    .map((step) => {
      const terminal =
        step.terminal ??
        step.output.reduce(
          (text, part) => appendTerminal(text, part.stream, part.text),
          emptyTerminal(),
        );
      const text = [
        terminalDisplayed(terminal, "stdout").text,
        terminalDisplayed(terminal, "stderr").text,
        ...model.changes
          .filter((change) => change.step === step.id && change.type === "file")
          .map((change) => `${change.op}: ${change.path}\n${change.patch ?? ""}`),
      ]
        .filter(Boolean)
        .join("\n");
      const kept = text.slice(-Math.max(0, budget));
      const output = budget > 0 ? kept : "";
      budget -= output.length;
      return {
        id: step.id,
        title: (step.tool?.title || step.intent || "Background work")
          .replace(/\s+/g, " ")
          .slice(0, 240),
        text: output,
        status: step.status,
        shortened: text.length > output.length || step.outputTruncated,
      };
    })
    .reverse();
  return { entries, background: !!all.at(-1) && backgroundStep(all.at(-1) as AgentStep) };
}

const showListeners = new Set<() => void>();
export function requestShowCommands() {
  for (const listener of showListeners) listener();
}
export function onShowCommands(listener: () => void) {
  showListeners.add(listener);
  return () => {
    showListeners.delete(listener);
  };
}
