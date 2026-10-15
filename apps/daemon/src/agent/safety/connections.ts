import {
  type ActionClass,
  type AlwaysOption,
  APPROVAL_TIMEOUT_MS,
  ApprovalAnswer,
  type ApprovalCard,
  ApprovalCard as CardSchema,
  type KeydAsk,
  type TaintKind,
  ulid,
} from "@localdot/protocol";
import type { PurposeGate } from "./purpose.ts";
import type { Place, RulesStore } from "./rules.ts";
import type { TaskTaint } from "./taint.ts";
import type { TaskAutonomy } from "./task-autonomy.ts";

// "Allow once" lets the waiting connections through and the program's retries for a minute: a
// program whose own timeout ran out while the card waited connects again on its next try.
export const ONCE_MS = 60_000;
// keyd lets a held connection go after this long (DefaultAskHold); one let go before its card
// showed needs no card, since the program's next try asks again.
export const HOLD_MS = 120_000;
// As many destinations as keyd holds connections for at once: more are refused without a card.
export const MAX_WAITING = 16;
// The card's word for a program desktopd couldn't name.
export const NOT_KNOWN = "Not known";
// Chromium keeps a push-messaging connection open whatever the task; refusing it costs nothing.
const BACKGROUND = [
  {
    app: /^(?:chromium|(?:google-)?chrome)\b/i,
    host: /^(?:alt\d+-)?mtalk\.google\.com$/i,
    ports: [5228, 5229, 5230],
  },
];
const background = (app: string | undefined, host: string, port: number) =>
  BACKGROUND.some(
    (known) => known.app.test(app ?? "") && known.host.test(host) && known.ports.includes(port),
  );

export interface ConnectionRequest {
  readonly app?: string;
  readonly host: string;
  readonly port: number;
  // One sentence on why this asks, worked out only when its card is shown.
  why(): Promise<string>;
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

const SOURCES: Readonly<Record<TaintKind, string>> = {
  screen: "pages from your accounts",
  memory: "what it remembers about you",
  files: "your files",
  recall: "your past conversations",
  app: "your connected apps",
};

// Why a connection asks, in the purpose check's words when it could judge the destination; null
// when the check is off.
export function connectionWhy(
  app: string | undefined,
  fits: boolean | null | undefined,
  read: readonly TaintKind[],
): string {
  const who = app ?? "This app";
  if (fits === null)
    return `${who} hasn't used this destination before. Apps reach websites on their own; anything else waits for your OK.`;
  if (fits === true)
    return `${who} hasn't used this destination before. It looks related to your task.`;
  if (fits === false) {
    const sources = read.map((kind) => SOURCES[kind]);
    const what =
      sources.length > 1 ? `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}` : sources[0];
    return `${who} hasn't used this destination before, and it doesn't look related to your task${what ? `. dot has read ${what} in this task` : ""}.`;
  }
  return `${who} hasn't used this destination before, and the purpose check couldn't tell whether it fits your task.`;
}

const WEB_CHECK = /(?:^|[\s;|&(`])(?:curl|wget2?)(?=\s|$)/;
const NO_PROXY = /--no-?proxy|no_proxy=/i;
// dot hears how to test an app's own route with each web check through the proxy, at most this
// often.
const ROUTE_NOTE_MS = 60_000;

interface Entry {
  readonly key: string;
  readonly request: ConnectionRequest;
  readonly waiters: ((decision: ConnectionDecision) => void)[];
  // When keyd lets go of the newest connection waiting on this entry.
  heldUntil: number;
  card?: ApprovalCard;
  timer?: ReturnType<typeof setTimeout>;
}

// A task's cards for connections that wait for the user: one shown at a time, the rest queued, and
// the connections one program makes to one destination share a card. They answer through the
// task's approval route but are no step of the agent's, so its Pause, brain and takeovers leave
// them waiting; only the end of the task refuses them. dot hears of each card and answer on its
// next tool result, so it never takes a held connection for a broken network.
export class ConnectionCards {
  readonly #queue: Entry[] = [];
  readonly #notes: string[] = [];
  #revision = 0;
  #routeNotedAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly task: string,
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
    const heldUntil = this.now() + HOLD_MS;
    return new Promise((resolve) => {
      this.#drop((entry) => entry !== this.#queue[0] && entry.heldUntil <= this.now());
      const same = this.#queue.find((entry) => entry.key === key);
      if (same) {
        same.waiters.push(resolve);
        same.heldUntil = heldUntil;
        return;
      }
      if (this.#queue.length >= MAX_WAITING) {
        resolve({ allow: false });
        return;
      }
      this.#queue.push({ key, request, waiters: [resolve], heldUntil });
      if (this.#queue.length === 1) void this.#show();
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
  // What changed for the task's connections since dot last heard, in plain words for the model.
  takeNotes(): string | undefined {
    const notes = this.#notes.splice(0);
    return notes.length ? notes.join("\n") : undefined;
  }
  // A web check from the shell goes through the proxy, so it says nothing of an app that ignores
  // the proxy; dot hears that with the checks it makes that way, so a later one is never taken
  // for the app's own route.
  checkedThroughProxy(command: string): void {
    const now = this.now();
    if (
      now - this.#routeNotedAt < ROUTE_NOTE_MS ||
      !WEB_CHECK.test(command) ||
      NO_PROXY.test(command)
    )
      return;
    this.#routeNotedAt = now;
    this.#note(
      "curl and wget in the computer go through its proxy, so they only show that websites work. An app that ignores the proxy takes its own route: test that route with curl --noproxy '*' -m 10 -sv https://<host>, or telnet://<host>:<port> </dev/null for another port.",
    );
  }
  #note(text: string): void {
    this.#notes.push(text);
    if (this.#notes.length > 8) this.#notes.shift();
  }
  // Settles the queued entries that match without a card: their connections are already let go.
  #drop(match: (entry: Entry) => boolean): void {
    for (const entry of this.#queue.filter(match)) {
      this.#queue.splice(this.#queue.indexOf(entry), 1);
      for (const resolve of entry.waiters) resolve({ allow: false });
    }
  }
  // Shows the first entry whose connection keyd still holds, with the purpose check's reason.
  async #show(): Promise<void> {
    this.#drop((entry) => !entry.card && entry.heldUntil <= this.now());
    const entry = this.#queue[0];
    if (!entry) return;
    const { app, host, port } = entry.request;
    const why = await entry.request.why().catch(() => connectionWhy(app, undefined, []));
    // The task ended, or the entry was settled, while its reason was worked out.
    if (this.#queue[0] !== entry || entry.card) return;
    const destination = destinationOf(host, port);
    const name = short(host, 120);
    entry.card = CardSchema.parse({
      actionClass: "network",
      risk: "medium",
      // The name is the program's own claim, which any program can make: the card says so, and so
      // does the reach of its Always.
      title: short(
        `${app ? `An app named ${app}` : "An app"} wants to connect to ${name} on port ${port}`,
        200,
      ),
      why: short(why, 400),
      fields: [
        ["App", app ?? NOT_KNOWN],
        ["Destination", `${name} · port ${port}`],
        ["For the task", short(this.task, 200)],
      ],
      always: [
        { scope: "task", label: "For this task", destination },
        {
          scope: "destination",
          label: short(
            `Always for ${app ? `apps named ${app} on ` : ""}${name} · port ${port}`,
            200,
          ),
          destination,
          ...(app ? { app } : {}),
        },
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
    this.#note(
      `${app ? `The app "${app}"` : "An app on the computer"} is waiting for the user's OK to connect to ${destination}. The user sees a card for it; this is not a network fault. Carry on with other steps, or tell the user it is waiting.`,
    );
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
      const { app, host, port } = entry.request;
      const who = app ? `the app "${app}"` : "the app";
      if (by === "user")
        this.#note(
          decision.allow
            ? `The user allowed ${who} to connect to ${destinationOf(host, port)}; it connects on its next try.`
            : `The user didn't allow ${who} to connect to ${destinationOf(host, port)}. Don't work around it; tell the user what doesn't work without it.`,
        );
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
    if (next) void this.#show();
  }
}

export interface ConnectionTask {
  readonly id: string;
  readonly taskAutonomy: Pick<TaskAutonomy, "relaxes">;
  readonly connections: Pick<ConnectionCards, "request">;
  readonly taint: Pick<TaskTaint, "kinds">;
  readonly purpose?: Pick<PurposeGate, "fitsConnection"> | undefined;
  permissionMode?(): "custom" | "auto" | "full";
  autoPermit?(
    action: { tool: string; operation: string; actionClass: string; input: unknown },
    signal: AbortSignal,
  ): Promise<boolean>;
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
  now?(): number;
}

const JUDGE_WAIT_MS = 10_000;

// Answers keyd for every connection it holds beyond the web: a saved rule, the task's allowance or
// a recent "Allow once" lets it through at once; otherwise the running task shows a card, with the
// purpose check's view of the destination as its reason. Without a task nobody can say yes, so it
// is refused. Nothing here reaches past keyd's own limits (SMTP, the Mac, its networks, link-local
// and metadata), which keyd applies before it asks.
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
    if (!task) return false;
    if (task.permissionMode?.() === "full") return true;
    if (background(app, held.host, held.port)) return false;
    if (task.permissionMode?.() === "auto" && task.autoPermit) {
      const allowed = await task
        .autoPermit(
          {
            tool: "network",
            operation: "connect",
            actionClass: "network",
            input: { host: held.host, port: held.port, app },
          },
          AbortSignal.timeout(JUDGE_WAIT_MS),
        )
        .catch(() => false);
      if (this.deps.task(cellId)?.id !== task.id) return false;
      if (allowed && task.permissionMode?.() === "auto") {
        this.#once.set(once, (this.deps.now?.() ?? Date.now()) + ONCE_MS);
        return true;
      }
    }
    const decision = await task.connections.request({
      ...(app ? { app } : {}),
      host: held.host,
      port: held.port,
      why: async () => {
        const fits = task.purpose
          ? await task.purpose
              .fitsConnection(held.host, held.port, AbortSignal.timeout(JUDGE_WAIT_MS))
              .catch(() => undefined)
          : null;
        return connectionWhy(app, fits, fits === false ? task.taint.kinds : []);
      },
    });
    if (decision.allow && !decision.always)
      this.#once.set(once, (this.deps.now?.() ?? Date.now()) + ONCE_MS);
    return decision.allow;
  }
}
