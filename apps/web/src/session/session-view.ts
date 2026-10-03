import { msToSeconds, type Rect } from "@localdot/protocol";
import { type ActionState, type SessionModel, sceneAt } from "@localdot/stage";
import type { HudState } from "../cells/hud-state.ts";

export interface SessionHud {
  label: string;
  caption: string;
  elapsedS: number | null;
  control: boolean;
  state: "working" | "idle" | "done" | "stopped" | "error";
}

export interface StepRowView {
  id: string;
  label: string;
  startT: number;
  status: "doing" | "ok" | "failed" | "cancelled";
  frameId?: string;
  target?: Rect;
  durationMs: number | null;
}

const PROGRESSIVE: [RegExp, string][] = [
  [/^Click\b/, "Clicking"],
  [/^Type\b/, "Typing"],
  [/^Press\b/, "Pressing"],
  [/^Scroll\b/, "Scrolling"],
  [/^Open\b/, "Opening"],
  [/^Wait\b/, "Waiting"],
];
const PAST: [RegExp, string][] = [
  [/^Click\b/, "Clicked"],
  [/^Type\b/, "Typed"],
  [/^Press\b/, "Pressed"],
  [/^Scroll\b/, "Scrolled"],
  [/^Open\b/, "Opened"],
  [/^Wait\b/, "Waited"],
];
const tense = (label: string, table: [RegExp, string][]) =>
  table.reduce((l, [re, to]) => l.replace(re, to), label);

export function sessionHud(model: SessionModel, nowMs: number): SessionHud {
  const scene = sceneAt(model, nowMs, { reducedMotion: true });
  const elapsedS =
    scene.hud.elapsedMs >= 5000 ? Math.floor(msToSeconds(scene.hud.elapsedMs)) : null;
  if (scene.hud.state === "done")
    return { label: "Done", caption: "Done.", elapsedS, control: false, state: "done" };
  if (scene.hud.state === "stopped")
    return { label: "Stopped", caption: "Stopped.", elapsedS, control: false, state: "stopped" };
  if (scene.hud.state === "error")
    return {
      label: "Failed",
      caption: scene.hud.label || "The step failed.",
      elapsedS,
      control: false,
      state: "error",
    };
  const label = scene.hud.label ? tense(scene.hud.label, PROGRESSIVE) : "Working";
  return {
    label,
    caption: scene.hud.label || "Starting…",
    elapsedS,
    control: scene.control,
    state: scene.hud.state === "working" ? "working" : "idle",
  };
}

export function mergeHud(
  hud: HudState,
  session: SessionHud | null,
): HudState & { control: boolean; elapsedS?: number | null; stop?: boolean } {
  // Pause is authoritative even when the session-end event arrives after cell status.
  if (!session || hud.paused) return { ...hud, control: false };
  if (session.state === "done" || session.state === "stopped" || session.state === "error") {
    // A finished session keeps its verdict while the computer is live; the computer's controls return.
    return {
      ...hud,
      ...(hud.live ? { label: session.label } : {}),
      caption: session.caption,
      control: false,
    };
  }
  return {
    ...hud,
    label: session.label,
    caption: session.caption,
    control: session.control,
    elapsedS: session.elapsedS,
    stop: true,
  };
}

export function stepRows(model: SessionModel): StepRowView[] {
  const rows = new Map<string, StepRowView>();
  const stepOf = (a: ActionState) => a.step ?? a.id;
  for (const a of model.actions) {
    const id = stepOf(a);
    const done = a.resultT ?? a.cancel?.t;
    const status: StepRowView["status"] = a.cancel
      ? a.cancel.reason === "user"
        ? "cancelled"
        : "failed"
      : a.resultT === undefined
        ? "doing"
        : a.ok
          ? "ok"
          : "failed";
    rows.set(id, {
      id,
      startT: rows.get(id)?.startT ?? a.intentT,
      label: done === undefined ? tense(a.label, PROGRESSIVE) : tense(a.label, PAST),
      status,
      ...(a.target?.bbox ? { target: a.target.bbox } : {}),
      durationMs: done === undefined ? null : Math.round(done - a.intentT),
    });
  }
  // The frame a step ends with is the observe appended inside it; the model keeps observes by
  // step through the actions' order: the latest observe at or before the result belongs to it.
  return [...rows.values()].map((row) => ({
    ...row,
    ...(frameFor(model, row.id) ? { frameId: frameFor(model, row.id) } : {}),
  }));
}

function frameFor(model: SessionModel, step: string): string | undefined {
  return model.frames?.get(step);
}
