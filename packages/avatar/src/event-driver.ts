import type { LocalDotEvent, Rect } from "@localdot/protocol";
import { AttentionEngine } from "./attention.ts";
import type { Point } from "./gaze.ts";
import type { ReactionKind } from "./reactions.ts";
import type { AgentStateName } from "./states.ts";

export interface AvatarSink {
  setState(state: AgentStateName): void;
  setAttention(point: Point | null): void;
  react(kind: ReactionKind): boolean;
}

export const ERROR_STREAK_MS = 60_000;

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function largest(rects: readonly Rect[]): Rect | undefined {
  let best: Rect | undefined;
  for (const r of rects) if (!best || r.w * r.h > best.w * best.h) best = r;
  return best;
}

export class EventDriver {
  readonly attention = new AttentionEngine();
  readonly #sink: AvatarSink;
  readonly #toPage: (p: Point) => Point;
  readonly #now: () => number;
  #lastErrorAt = Number.NEGATIVE_INFINITY;
  #approvalPending = false;
  #waitingForUser = false;

  constructor(
    sink: AvatarSink,
    toPage: (p: Point) => Point,
    now: () => number = () => performance.now(),
  ) {
    this.#sink = sink;
    this.#toPage = toPage;
    this.#now = now;
  }

  handle(event: LocalDotEvent): void {
    const t = this.#now();
    switch (event.type) {
      case "agent.state":
        this.#sink.setState(event.data.state);
        this.#waitingForUser = event.data.state === "waiting_user";
        this.#faceUser(t);
        break;
      case "action.intent":
        if (event.data.point) this.attention.set("target", this.#toPage(event.data.point), t);
        break;
      case "action.target": {
        const { bbox, point } = event.data.target;
        this.attention.set("target", this.#toPage(bbox ? centre(bbox) : point), t);
        break;
      }
      case "action.dispatch":
        this.#sink.react("nod");
        break;
      case "action.result":
        if (!event.data.ok) this.#error(t);
        break;
      case "action.cancel":
        if (event.data.reason === "preflight" || event.data.reason === "stale")
          this.#sink.react("surprise");
        break;
      case "step.verify":
        if (event.data.status === "failed") this.#error(t);
        else if (event.data.status === "unexpected") this.#sink.react("surprise");
        break;
      case "screen.settle": {
        const region = event.data.noVisibleChange ? undefined : largest(event.data.changed);
        if (region) this.attention.set("changed", this.#toPage(centre(region)), t);
        break;
      }
      case "approval.request":
        this.#approvalPending = true;
        this.#faceUser(t);
        break;
      case "approval.resolve":
        this.#approvalPending = false;
        this.#faceUser(t);
        if (event.data.decision === "approve") this.#sink.react("nod");
        break;
      case "session.start":
        this.#resetSession(t);
        break;
      case "session.end":
        if (event.data.reason === "done") this.#sink.react("cheer");
        else if (event.data.reason === "error") this.#error(t);
        this.#resetSession(t);
        break;
    }
  }

  update(): void {
    this.#sink.setAttention(this.attention.resolve(this.#now()).point);
  }

  // The "approval" source is the top priority: she faces the user for an approval or a question.
  #faceUser(t: number): void {
    if (this.#approvalPending || this.#waitingForUser) this.attention.set("approval", null, t);
    else this.attention.clear("approval");
  }

  #resetSession(t: number): void {
    this.#approvalPending = false;
    this.#waitingForUser = false;
    this.#faceUser(t);
    this.#lastErrorAt = Number.NEGATIVE_INFINITY;
  }

  #error(t: number): void {
    this.#sink.react(t - this.#lastErrorAt <= ERROR_STREAK_MS ? "hmph" : "wince");
    this.#lastErrorAt = t;
  }
}
