import type { LocalDotEvent } from "@localdot/protocol";
import type { WorkWindowUpdate } from "../../../../packages/protocol/src/work-window.ts";

type Endpoint = { baseUrl: string; token: string };
type Display = {
  endpoint: Endpoint;
  update: WorkWindowUpdate;
  step: string;
  presented: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// Passive event fan-out. The source is the same redacted journal as Activity; there
// are no extra agent turns, commands, file reads or output polling.
export class WorkWindowFeed {
  readonly #shown = new Map<string, Display>();
  readonly #steps = new Map<string, { step: string; kind: string; intent?: string }>();
  readonly #hiding = new Map<string, Promise<void>>();
  readonly #sending = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, { endpoint: Endpoint; update: WorkWindowUpdate }>();
  constructor(
    private readonly deps: {
      target(id: string): Endpoint | undefined;
      send?(endpoint: Endpoint, update: WorkWindowUpdate): Promise<void>;
    },
  ) {}

  event(id: string, event: LocalDotEvent): void {
    const target = this.deps.target(id);
    if (
      !target ||
      event.type === "session.end" ||
      event.type === "screen.switch" ||
      (event.type === "agent.state" &&
        ["waiting_user", "paused", "error", "done", "idle"].includes(event.data.state))
    ) {
      this.hide(id);
      return;
    }
    if (event.type === "step.start") {
      const step = event.step ?? event.id;
      this.#steps.set(id, { step, kind: event.data.kind, intent: event.data.intent });
      if (["gui", "ask"].includes(event.data.kind)) {
        void this.hide(id);
        return;
      }
      if (["shell", "file", "app"].includes(event.data.kind))
        this.#begin(id, target, step, event.data.intent ?? "Working in the background");
      // "browser" also labels public search/fetch. Wait for the tool's actual identity.
    }
    if (event.type === "tool.start") {
      const step = this.#steps.get(id);
      if (step?.kind === "browser" && step.step === event.step) {
        if (!["web_search", "web_fetch"].includes(event.data.tool)) {
          void this.hide(id);
          return;
        }
        this.#begin(id, target, step.step, event.data.title ?? "Reading the web");
      }
    }
    const display = this.#shown.get(id);
    if (!display || (event.step && event.step !== display.step)) return;
    if (event.type === "tool.start") {
      display.update.title = event.data.title ?? event.data.tool;
      display.update.text += `${display.update.text ? "\n" : ""}${event.data.tool === "shell" ? "$ " : ""}${event.data.title ?? event.data.tool}\n\n`;
    } else if (event.type === "tool.output") display.update.text += event.data.chunk;
    else if (event.type === "file.change")
      display.update.text += `${event.data.op}: ${event.data.path}\n${event.data.patch ?? ""}\n`;
    else if (event.type === "step.end")
      display.update.text += `\n${event.data.status === "ok" ? "Finished" : event.data.status}${event.data.note ? ` · ${event.data.note}` : ""}\n`;
    else if (event.type !== "step.start") return;
    display.update.text = display.update.text.slice(-12000);
    if (!display.timer)
      display.timer = setTimeout(
        () => {
          display.timer = undefined;
          if (this.#shown.get(id) !== display) return;
          const current = this.deps.target(id);
          if (
            current?.baseUrl !== display.endpoint.baseUrl ||
            current.token !== display.endpoint.token
          ) {
            this.hide(id);
            return;
          }
          display.presented = true;
          this.#send(display.endpoint, { ...display.update });
        },
        display.presented ? 120 : 650,
      );
  }

  #begin(id: string, endpoint: Endpoint, step: string, title: string): void {
    const previous = this.#shown.get(id);
    if (
      previous?.endpoint.baseUrl === endpoint.baseUrl &&
      previous.endpoint.token === endpoint.token
    ) {
      // A background sequence is one display phase, with one entrance and a retained transcript.
      previous.step = step;
      previous.update.title = title;
      return;
    }
    if (previous) void this.hide(id);
    this.#shown.set(id, {
      endpoint,
      step,
      presented: false,
      update: { phase: `${id}/${step}`, visible: true, title, text: "" },
    });
  }

  hide(id: string): Promise<void> {
    this.#steps.delete(id);
    const display = this.#shown.get(id);
    if (!display) return this.#hiding.get(id) ?? Promise.resolve();
    clearTimeout(display.timer);
    this.#shown.delete(id);
    const hidden = this.#send(display.endpoint, { ...display.update, visible: false, text: "" });
    this.#hiding.set(id, hidden);
    void hidden.finally(() => {
      if (this.#hiding.get(id) === hidden) this.#hiding.delete(id);
    });
    return hidden;
  }

  close(): void {
    for (const id of this.#shown.keys()) this.hide(id);
  }

  #send(endpoint: Endpoint, update: WorkWindowUpdate): Promise<void> {
    const key = endpoint.baseUrl;
    this.#pending.set(key, { endpoint, update });
    const active = this.#sending.get(key);
    if (active) return active;
    const pending = Promise.resolve().then(() => this.#drain(key));
    this.#sending.set(key, pending);
    return pending;
  }

  async #drain(key: string): Promise<void> {
    try {
      for (;;) {
        const next = this.#pending.get(key);
        if (!next) break;
        this.#pending.delete(key);
        const { endpoint, update } = next;
        if (update.visible) {
          const owner = [...this.#shown.entries()].find(([, d]) => d.update.phase === update.phase);
          const current = owner && this.deps.target(owner[0]);
          if (!current || current.baseUrl !== endpoint.baseUrl || current.token !== endpoint.token)
            continue;
        }
        try {
          if (this.deps.send) await this.deps.send(endpoint, update);
          else
            await fetch(`${endpoint.baseUrl}/work-window`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${endpoint.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(update),
              signal: AbortSignal.timeout(2000),
            }).then((reply) => reply.body?.cancel());
        } catch {
          /* Display failures do not fail or restart the computer. */
        }
      }
    } finally {
      this.#sending.delete(key);
    }
  }
}
