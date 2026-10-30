import { ulid } from "@localdot/protocol";
import { modelControls } from "@localdot/providers";
import type { fetch as undiciFetch } from "undici";
import { bindingOf, pricingOf, type ResolvedRole } from "../agent/bindings.ts";
import { leastEffort } from "../agent/first-look.ts";
import { gatewayCompletion } from "../agent/safety/judge-model.ts";
import type { KeydClient } from "./client.ts";

const CELL = "quick-model";

export interface QuickModelDeps {
  keyd: Pick<
    KeydClient,
    | "openCell"
    | "closeCell"
    | "beginPricedTask"
    | "modelAdmission"
    | "setModelAdmission"
    | "endTask"
  >;
  // A keyd listener port no computer or brain uses, and its return.
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
}

// One short answer from a task's model before its brain starts, at the model's least thinking.
// The call goes through a listener of the daemon's own that holds only that model's key, priced as
// the task prices it, so keyd swaps in the real key and counts the cost against the day's limit.
// Calls take turns on the one listener.
export class QuickModel {
  #turn: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: QuickModelDeps) {}
  ask(role: ResolvedRole, system: string, prompt: string, signal: AbortSignal): Promise<string> {
    const asked = this.#turn.then(() => this.#ask(role, system, prompt, signal));
    this.#turn = asked.catch(() => {});
    return asked;
  }
  async #ask(
    role: ResolvedRole,
    system: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const { keyd } = this.deps;
    const port = this.deps.ports.reserve();
    let opened = false;
    try {
      // A listener left by an earlier run of the daemon holds a stand-in nobody has any more.
      await keyd.closeCell(CELL).catch(() => false);
      const cell = await keyd.openCell({
        cellId: CELL,
        role: "brain",
        port,
        secrets: role.keyId ? [role.keyId] : [],
      });
      opened = true;
      if (cell.port !== port) throw new Error("keyd did not open the quick listener as asked");
      const taskId = ulid();
      await keyd.beginPricedTask(CELL, taskId, pricingOf([role]));
      const owner = await keyd.modelAdmission(CELL);
      if (owner.taskId !== taskId || owner.retired) throw new Error("quick listener owner changed");
      const open = await keyd.setModelAdmission(CELL, {
        taskId,
        generationId: owner.generationId,
        expectedEpoch: owner.epoch,
        state: "open",
      });
      if (open.taskId !== taskId || open.paused || open.retired)
        throw new Error("quick listener admission was not opened");
      signal.throwIfAborted();
      const binding = bindingOf(role, cell.surrogates ?? {});
      const effort = leastEffort(
        modelControls(role.providerId, role.model.id, role.model.controls).efforts,
      );
      return await gatewayCompletion(
        () => binding,
        () => ({ port, token: cell.proxyToken }),
        this.deps.fetch,
        effort,
      )(system, prompt, signal);
    } finally {
      if (opened) {
        await keyd.endTask(CELL).catch(() => {});
        await keyd.closeCell(CELL).catch(() => false);
      }
      this.deps.ports.release(port);
    }
  }
}
