import { type LocalDotEvent, sessionMsOf } from "@localdot/protocol";
import type { AgentModel, AgentStep } from "../agent/model.ts";
import { terminalDisplayed } from "../agent/terminal-text.ts";

export const WORK_LIMITS = Object.freeze({ text: 6000, lines: 80, frames: 160, sampleMs: 500 });
export interface WorkCard {
  key: string;
  kind: "Command" | "Files" | "Research";
  title: string;
  text: string;
  shortened: boolean;
  status: string;
  image?: NonNullable<AgentStep["images"]>[number];
}
export function workTail(text: string): { text: string; shortened: boolean } {
  const tail = text.slice(-WORK_LIMITS.text).split("\n").slice(-WORK_LIMITS.lines).join("\n");
  return { text: tail, shortened: tail.length < text.length };
}
// Deliberately allowlisted. GUI/browser/private-input tools always keep their real screen.
// This reads the already redacted, bounded UI projection; it never asks the agent for narration.
export function workCard(model: AgentModel): WorkCard | null {
  if (model.pendingAsk || model.pendingTakeover || model.approval || model.connection) return null;
  let step: AgentStep | undefined;
  for (const value of model.steps.values()) step = value;
  if (!step) return null;
  const tool = step.tool?.name;
  const kind =
    tool === "shell"
      ? "Command"
      : tool === "files"
        ? "Files"
        : tool === "web_search" || tool === "web_fetch" || tool === "research"
          ? "Research"
          : null;
  if (!kind) return null;
  const change = model.changes.findLast((entry) => entry.type === "file" && entry.step === step.id);
  const output = step.terminal
    ? [
        terminalDisplayed(step.terminal, "stdout").text,
        terminalDisplayed(step.terminal, "stderr").text,
      ]
        .filter(Boolean)
        .join("\n")
    : step.output.map((part) => part.text).join("");
  const tail = workTail(
    change ? `${change.op ?? "Changed"} ${change.path}\n${change.patch ?? ""}` : output,
  );
  return {
    key: step.id,
    kind,
    title: (step.intent || step.tool?.title || kind).slice(0, 200),
    ...tail,
    shortened: tail.shortened || step.outputTruncated || !!change?.truncated,
    status:
      step.status === "failed" || step.tool?.ok === false
        ? "Failed"
        : step.status === "blocked"
          ? "Blocked"
          : step.status === "cancelled"
            ? "Cancelled"
            : step.endedAt !== undefined
              ? "Finished"
              : model.ended
                ? "Stopped"
                : "Working",
    image: step.images?.at(-1),
  };
}

// A bounded replay supplement, built during the existing history read. Evicted early work falls
// back to the original recording. Samples are timestamped AFTER the event, never backdated.
export class WorkHistory {
  readonly frames: { at: number; card: WorkCard | null }[] = [];
  private seq = -1;
  add(event: LocalDotEvent, model: AgentModel) {
    if (event.seq <= this.seq) return;
    this.seq = event.seq;
    if (
      ![
        "step.start",
        "tool.start",
        "tool.output",
        "tool.end",
        "step.end",
        "session.end",
        "file.change",
        "ask.request",
        "takeover.request",
        "approval.request",
      ].includes(event.type)
    )
      return;
    const at = sessionMsOf(event);
    const last = this.frames.at(-1);
    if (event.type === "tool.output" && last && at - last.at < WORK_LIMITS.sampleMs) return;
    const card = workCard(model);
    if (JSON.stringify(last?.card) === JSON.stringify(card)) return;
    this.frames.push({ at, card });
    if (this.frames.length > WORK_LIMITS.frames) this.frames.shift();
  }
  at(time: number): WorkCard | null {
    let lo = 0;
    let hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.frames[mid]?.at ?? Infinity) <= time) lo = mid + 1;
      else hi = mid;
    }
    return this.frames[lo - 1]?.card ?? null;
  }
}
