import {
  type ActionClass,
  type AlwaysOption,
  APPROVAL_TIMEOUT_MS,
  ApprovalAnswer,
  type ApprovalCard,
  ApprovalCard as CardSchema,
  type KeydAsk,
  ulid,
} from "@localdot/protocol";
import type { Place, RulesStore } from "./rules.ts";
import type { TaskAutonomy } from "./task-autonomy.ts";

// "Allow once" lets the waiting connections through and the program's retries for a minute: a
// program whose own timeout ran out while the card waited connects again on its next try.
export const ONCE_MS = 60_000;

export interface ConnectionRequest {
  readonly app?: string;
  readonly host: string;
  readonly port: number;
}
export type ConnectionDecision =
  | { readonly allow: true; readonly always?: AlwaysOption }
  | { readonly allow: false };
export interface ConnectionResolution {
  approvalId: string;
  decision: "approve" | "deny";
  by: "user" | "timeout";
  note?: string;
  always?: { readonly actionClass: ActionClass; readonly option: AlwaysOption };
}

export function destinationOf(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface Entry {
  readonly key: string;
  readonly request: ConnectionRequest;
  readonly waiters: ((decision: ConnectionDecision) => void)[];
  card?: ApprovalCard;
  timer?: ReturnType<typeof setTimeout>;
}

// A task's cards for connections that wait for the user: one shown at a time, the rest queued, and
// the connections one program makes to one destination share a card. They answer through the
// task's approval route but are no step of the agent's, so its Pause, brain and takeovers leave
// them waiting; only the end of the task refuses them.
export class ConnectionCards {
  readonly #queue: Entry[] = [];
  #revision = 0;
  constructor(
    private readonly publishRequest: (card: ApprovalCard) => void,
    private readonly publishResolution: (resolution: ConnectionResolution) => void,
    private readonly now: () => number = Date.now,
  ) {}
  get pending(): ApprovalCard | undefined {
    const card = this.#queue[0]?.card;
    return card ? structuredClone(card) : undefined;
  }
  request(request: ConnectionRequest): Promise<ConnectionDecision> {
    const key = `${request.app ?? ""}\0${destinationOf(request.host, request.port)}`;
    return new Promise((resolve) => {
      const same = this.#queue.find((entry) => entry.key === key);
      if (same) {
        same.waiters.push(resolve);
        return;
      }
      this.#queue.push({ key, request, waiters: [resolve] });
      if (this.#queue.length === 1) this.#show();
    });
  }
  owns(approvalId: string): boolean {
    return this.#queue[0]?.card?.approvalId === approvalId;
  }
  answer(value: unknown): boolean {
    const answer = ApprovalAnswer.safeParse(value);
    const card = this.#queue[0]?.card;
    if (
      !answer.success ||
      !card ||
      answer.data.approvalId !== card.approvalId ||
      answer.data.generation !== card.generation ||
      answer.data.revision !== card.revision ||
      answer.data.decision === "take_control"
    )
      return false;
    const scope = answer.data.always;
    const always = card.always?.find((option) => option.scope === scope);
    if (scope !== undefined && !always) return false;
    if (this.now() >= card.expiresAt) {
      this.#finish({ allow: false }, "timeout");
      return false;
    }
    this.#finish(
      answer.data.decision === "approve"
        ? { allow: true, ...(always ? { always } : {}) }
        : { allow: false },
      "user",
    );
    return true;
  }
  cancel(note: string): void {
    while (this.#queue.length) this.#finish({ allow: false }, "timeout", note, false);
  }
  #show(): void {
    const entry = this.#queue[0];
    if (!entry) return;
    const { app, host, port } = entry.request;
    const destination = destinationOf(host, port);
    const place = short(destination, 120);
    entry.card = CardSchema.parse({
      actionClass: "network",
      risk: "medium",
      title: short(`${app ?? "A program"} wants to connect to ${place}`, 200),
      fields: [
        ["Program", app ?? "Not known"],
        ["Destination", destination],
      ],
      always: [
        { scope: "task", label: "For this task", destination },
        ...(app ? [{ scope: "app", label: short(`Always for ${app}`, 200), app }] : []),
        { scope: "destination", label: `Always for ${place}`, destination },
      ],
      approvalId: ulid(),
      generation: 1,
      revision: ++this.#revision,
      expiresAt: this.now() + APPROVAL_TIMEOUT_MS,
    });
    entry.timer = setTimeout(() => {
      if (this.#queue[0] === entry) this.#finish({ allow: false }, "timeout");
    }, APPROVAL_TIMEOUT_MS);
    entry.timer.unref?.();
    this.publishRequest(structuredClone(entry.card));
  }
  #finish(
    decision: ConnectionDecision,
    by: ConnectionResolution["by"],
    note?: string,
    next = true,
  ) {
    const entry = this.#queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const resolve of entry.waiters) resolve(decision);
    const card = entry.card;
    if (card) {
      try {
        this.publishResolution({
          approvalId: card.approvalId,
          decision: decision.allow ? "approve" : "deny",
          by,
          ...(note ? { note } : {}),
          ...(decision.allow && decision.always
            ? { always: { actionClass: "network", option: decision.always } }
            : {}),
        });
      } catch {
        // A lost event cannot undo an answer already given.
      }
    }
    if (next) this.#show();
  }
}

export interface ConnectionTask {
  readonly id: string;
  readonly taskAutonomy: Pick<TaskAutonomy, "relaxes">;
  readonly connections: Pick<ConnectionCards, "request">;
}
export interface ConnectionApprovalsDeps {
  keyd: {
    asks(cellId: string): Promise<KeydAsk[]>;
    answerAsk(
      cellId: string,
      askId: string,
      decision: "allow" | "deny",
      app?: string,
    ): Promise<void>;
  };
  // The running task on a computer, which shows the cards.
  task(cellId: string): ConnectionTask | undefined;
  rules: Pick<RulesStore, "matches">;
  // The program behind a local port of the computer, when the computer can say.
  owner(cellId: string, port: number): Promise<string | undefined>;
  cells(): Iterable<string>;
  // The purpose judge's place: it may decide a destination before anyone is asked. Nothing it says
  // reaches past keyd's own limits (SMTP, the Mac, its networks, link-local and metadata).
  judge?(request: {
    cellId: string;
    taskId?: string;
    app?: string;
    host: string;
    port: number;
  }): Promise<"allow" | "deny" | undefined>;
  now?(): number;
}

// Answers keyd for every connection it holds: a saved rule, the task's allowance or a recent
// "Allow once" lets it through at once; otherwise the running task shows a card, and without a task
// nobody can say yes, so it is refused.
export class ConnectionApprovals {
  readonly #handling = new Set<string>();
  readonly #once = new Map<string, number>();
  constructor(private readonly deps: ConnectionApprovalsDeps) {}
  async ask(cellId: string, held: KeydAsk): Promise<void> {
    const id = `${cellId}\0${held.id}`;
    if (this.#handling.has(id)) return;
    this.#handling.add(id);
    try {
      const app = held.source
        ? await this.deps.owner(cellId, held.source).catch(() => undefined)
        : undefined;
      const allow = await this.#decide(cellId, held, app).catch(() => false);
      // keyd may have let the program go meanwhile; the answer still left its rule or allowance.
      await this.deps.keyd
        .answerAsk(cellId, held.id, allow ? "allow" : "deny", app)
        .catch(() => {});
    } finally {
      this.#handling.delete(id);
    }
  }
  // Picks up held connections whose event was missed, such as while the event stream reconnected.
  async sweep(): Promise<void> {
    for (const cellId of this.deps.cells()) {
      const held = await this.deps.keyd.asks(cellId).catch(() => []);
      for (const ask of held) void this.ask(cellId, ask);
    }
  }
  async #decide(cellId: string, held: KeydAsk, app: string | undefined): Promise<boolean> {
    const now = this.deps.now?.() ?? Date.now();
    const destination = destinationOf(held.host, held.port);
    const place: Place = { ...(app ? { app } : {}), destination };
    if (this.deps.rules.matches("network", place)) return true;
    const task = this.deps.task(cellId);
    if (task?.taskAutonomy.relaxes("network", place)) return true;
    for (const [key, until] of this.#once) if (until <= now) this.#once.delete(key);
    const once = `${cellId}\0${app ?? ""}\0${destination}`;
    if (this.#once.has(once)) return true;
    const judged = await this.deps.judge?.({
      cellId,
      ...(task ? { taskId: task.id } : {}),
      ...(app ? { app } : {}),
      host: held.host,
      port: held.port,
    });
    if (judged) return judged === "allow";
    if (!task) return false;
    const decision = await task.connections.request({
      ...(app ? { app } : {}),
      host: held.host,
      port: held.port,
    });
    if (decision.allow && !decision.always)
      this.#once.set(once, (this.deps.now?.() ?? Date.now()) + ONCE_MS);
    return decision.allow;
  }
}
