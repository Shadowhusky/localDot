import { type AgentModel, emptyAgentModel } from "@app/agent/model.ts";
import { projectAgentEvent } from "@app/agent/reducer.ts";
import type { LocalDotEvent } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";

// A recorded task told up to a moment: the app's chat model and its stage model, folded from the
// task's events as the clock reaches them, and folded again from the start when it goes back.
export class DemoFeed {
  agent: AgentModel = emptyAgentModel();
  stage: SessionModel = emptyModel();
  // Changes whenever either model does.
  version = 0;
  #next = 0;
  #at = Number.NEGATIVE_INFINITY;

  constructor(private readonly events: readonly LocalDotEvent[]) {}

  // `sessionMs` is milliseconds from the task's start, as its events' times are counted.
  advance(sessionMs: number): void {
    if (sessionMs < this.#at) this.#reset();
    this.#at = sessionMs;
    const upto = sessionMs * 1000;
    const from = this.#next;
    while (this.#next < this.events.length) {
      const event = this.events[this.#next] as LocalDotEvent;
      if (event.t > upto) break;
      this.agent = projectAgentEvent(this.agent, event);
      this.#next++;
    }
    if (this.#next > from) {
      foldEvents(this.stage, this.events.slice(from, this.#next));
      this.version++;
    }
  }

  #reset(): void {
    this.agent = emptyAgentModel();
    this.stage = emptyModel();
    this.#next = 0;
    this.version++;
  }
}
