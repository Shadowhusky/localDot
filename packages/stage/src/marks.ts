import { clipText, type LocalDotEvent, sessionMsOf } from "@localdot/protocol";
import { CURSOR_NAME } from "./scene.ts";
export type MarkKind =
  | "approval"
  | "decision"
  | "takeover"
  | "handback"
  | "pause"
  | "resume"
  | "tool"
  | "tool-failed"
  | "file"
  | "memory"
  | "key"
  | "verify"
  | "event";
export type MarkTone = "neutral" | "attention" | "failure" | "user";
export interface TimelineMark {
  t: number;
  seq: number;
  kind: MarkKind;
  type: string;
  step?: string;
  label: string;
  tone: MarkTone;
}
const ownDisplay = /^(?:session\.|plan\.|step\.|action\.)/;
const noise = new Set([
  "agent.state",
  "heartbeat",
  "thought.delta",
  "text.progress",
  "screen.settle",
  "observe",
  "tool.output",
  "camera.hint",
]);
export function markOf(e: LocalDotEvent): TimelineMark | null {
  const mark = (kind: MarkKind, label: string, tone: MarkTone = "neutral"): TimelineMark => ({
    t: sessionMsOf(e),
    seq: e.seq,
    kind,
    type: e.type,
    ...(e.step ? { step: e.step } : {}),
    label,
    tone,
  });
  switch (e.type) {
    case "takeover.request":
      return e.data.by === "user"
        ? mark("takeover", "You took control", "user")
        : mark("takeover", "Asked you to take control", "user");
    // The recording keeps that the user typed, never what.
    case "takeover.end":
      return e.data.by === "stop"
        ? mark(
            "pause",
            e.data.typed ? "You typed, then it stopped" : "Stopped during your control",
            "attention",
          )
        : mark(
            "handback",
            e.data.typed
              ? `You typed, then handed back to ${CURSOR_NAME}`
              : `Handed back to ${CURSOR_NAME}`,
          );
    case "approval.request":
      return mark("approval", `Asked to approve: ${clipText(e.data.title, 60)}`, "attention");
    case "approval.resolve":
      if (e.data.by === "timeout") return mark("decision", "Denied", "failure");
      return e.data.decision === "approve"
        ? mark("decision", "Approved")
        : e.data.decision === "deny"
          ? mark("decision", "Denied", "failure")
          : mark("decision", "You took control", "user");
    case "control.change":
      return e.data.holder === "user"
        ? mark("takeover", "You took control", "user")
        : mark("handback", `Handed back to ${CURSOR_NAME}`);
    case "pause.change":
      return e.data.paused ? mark("pause", "Paused") : mark("resume", "Resumed");
    case "tool.start":
      return mark("tool", clipText(e.data.title, 60));
    case "tool.end":
      return e.data.ok
        ? null
        : mark(
            "tool-failed",
            e.data.exitCode === undefined
              ? "Command failed"
              : `Command failed (exit ${e.data.exitCode})`,
            "failure",
          );
    case "file.change":
      return mark(
        "file",
        `${{ create: "Created", modify: "Edited", delete: "Deleted" }[e.data.op]} ${clipText(e.data.path.split(/[\\/]/).at(-1) ?? "", 48)}`,
      );
    case "memory.change":
      return mark("memory", `Updated ${e.data.file}`);
    case "key.use":
      return mark(
        "key",
        `${{ allow: "Used a key", deny: "Blocked a key", ask: "Asked to use a key" }[e.data.decision]} → ${clipText(e.data.host, 48)}`,
        { allow: "neutral", deny: "failure", ask: "attention" }[e.data.decision] as MarkTone,
      );
    case "step.verify":
      return mark(
        "verify",
        { success: "Verified", unexpected: "Unexpected result", failed: "Check failed" }[
          e.data.status
        ],
        { success: "neutral", unexpected: "attention", failed: "failure" }[
          e.data.status
        ] as MarkTone,
      );
    default:
      return ownDisplay.test(e.type) || noise.has(e.type) ? null : mark("event", e.type);
  }
}
