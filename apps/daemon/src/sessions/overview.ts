import {
  type Blocker,
  clipText,
  type LocalDotEvent,
  OVERVIEW_NEED_CHARS,
  OVERVIEW_PLAN_CHARS,
  type OverviewNeed,
  type OverviewTile,
  type ScreenName,
  type SessionCard,
} from "@localdot/protocol";
import type { EventLog } from "../event-log.ts";

// Tasks followed at once; the oldest seen goes first, and is read from its card if asked about again.
export const OVERVIEW_KEPT = 256;

interface PlanItem {
  text: string;
  status: "todo" | "doing" | "done" | "skipped";
}

interface Followed {
  frame?: string;
  screen?: ScreenName;
  steps: number;
  plan: Map<string, PlanItem>;
  // The plan item the latest step said it worked on.
  planItem?: string;
  // What it waits on the user for, by what raised it.
  needs: Map<string, OverviewNeed>;
}

const TAKEOVER: Record<string, string> = {
  login: "Sign in",
  "2fa": "Enter a sign-in code",
  captcha: "Prove it's a person",
  payment: "Enter payment details",
};

function fixText(blocker: Blocker): string {
  switch (blocker.kind) {
    case "app":
      return `Connect ${blocker.name} again`;
    case "key":
      return "A saved key was refused";
    case "keys_locked":
      return "Unlock your saved keys";
    case "computer":
      return blocker.state === "paused" ? "Resume the computer" : "Start the computer";
    case "runtime":
      return "Start Docker";
    case "model":
      return "The model can't go on";
  }
}

const line = (text: string) => clipText(text, OVERVIEW_NEED_CHARS);

// What the overview shows of each task beyond the conversation list: its latest screenshot, the
// screen it works on, its steps, its plan and what it waits on the user for. Followed from the event
// log as events are written, so a read costs no file; a task this daemon never saw is read once from
// its card and followed from there.
export class OverviewTracker {
  readonly #tasks = new Map<string, Followed>();
  readonly #card: (id: string) => Promise<SessionCard>;
  readonly #kept: number;
  readonly #off: () => void;

  constructor(
    eventLog: Pick<EventLog, "subscribe">,
    card: (id: string) => Promise<SessionCard>,
    kept = OVERVIEW_KEPT,
  ) {
    this.#card = card;
    this.#kept = kept;
    this.#off = eventLog.subscribe((id, event) => this.#see(id, event));
  }

  close(): void {
    this.#off();
  }

  forget(id: string): void {
    this.#tasks.delete(id);
  }

  async tile(id: string): Promise<OverviewTile> {
    let task = this.#tasks.get(id);
    if (!task) {
      const card = await this.#card(id);
      // Events written while the card was read have started following it already.
      task = this.#tasks.get(id) ?? this.#follow(id, false);
      task.steps = Math.max(task.steps, card.steps);
      task.frame ??= card.coverFrameId ?? undefined;
    }
    return tileOf(id, task);
  }

  #follow(id: string, fromStart: boolean): Followed {
    const task: Followed = { steps: 0, plan: new Map(), needs: new Map() };
    // A task starts on the desktop.
    if (fromStart) task.screen = "desktop";
    this.#tasks.set(id, task);
    for (const old of this.#tasks.keys()) {
      if (this.#tasks.size <= this.#kept) break;
      this.#tasks.delete(old);
    }
    return task;
  }

  #see(id: string, event: LocalDotEvent): void {
    let task = this.#tasks.get(id);
    if (event.type === "session.start") task = this.#follow(id, true);
    if (!task) return;
    switch (event.type) {
      case "observe":
        task.frame = event.data.frameId;
        break;
      case "screen.switch":
        task.screen = event.data.screen;
        break;
      case "step.start":
        task.steps++;
        if (event.data.planItem) task.planItem = event.data.planItem;
        break;
      case "plan.set":
        task.plan = new Map(
          event.data.items.map((item) => [item.id, { text: item.text, status: item.status }]),
        );
        break;
      case "plan.update": {
        const item = task.plan.get(event.data.id);
        if (item) item.status = event.data.status;
        break;
      }
      case "approval.request":
        task.needs.set(`approval:${event.data.approvalId}`, {
          reason: "approval",
          text: line(event.data.title),
        });
        break;
      case "approval.resolve":
        task.needs.delete(`approval:${event.data.approvalId}`);
        break;
      case "ask.request":
        task.needs.set(`ask:${event.data.askId}`, {
          reason: "question",
          text: line(event.data.question),
        });
        break;
      case "ask.answer":
        task.needs.delete(`ask:${event.data.askId}`);
        break;
      case "takeover.request":
        if (event.data.by !== "user")
          task.needs.set(`takeover:${event.data.requestId}`, {
            reason: "takeover",
            text: line(TAKEOVER[event.data.reason] ?? (event.data.note || "Take the computer")),
          });
        break;
      case "takeover.end":
        task.needs.delete(`takeover:${event.data.requestId}`);
        break;
      case "blocker.raise":
        task.needs.set(`fix:${event.data.blockerId}`, {
          reason: "fix",
          text: line(fixText(event.data.blocker)),
        });
        break;
      case "blocker.clear":
        task.needs.delete(`fix:${event.data.blockerId}`);
        break;
      case "session.end":
        task.needs.clear();
        break;
    }
    // Most recently heard from last, so the oldest is the first to go.
    this.#tasks.delete(id);
    this.#tasks.set(id, task);
  }
}

function tileOf(id: string, task: Followed): OverviewTile {
  const items = [...task.plan.values()];
  const done = items.filter((item) => item.status === "done" || item.status === "skipped").length;
  const current =
    items.find((item) => item.status === "doing") ??
    (task.planItem ? task.plan.get(task.planItem) : undefined) ??
    items.find((item) => item.status === "todo");
  const needs = [...task.needs.values()].at(-1);
  return {
    sessionId: id,
    ...(task.frame ? { frame: task.frame } : {}),
    ...(task.screen ? { screen: task.screen } : {}),
    steps: task.steps,
    ...(items.length
      ? {
          plan: {
            done,
            total: items.length,
            ...(current && current.status !== "done" && current.status !== "skipped"
              ? { current: clipText(current.text, OVERVIEW_PLAN_CHARS) }
              : {}),
          },
        }
      : {}),
    ...(needs ? { needs } : {}),
  };
}
