import { ulid } from "@localdot/protocol";
import { modelControls } from "@localdot/providers";
import type { fetch as undiciFetch } from "undici";
import { bindingOf, pricingOf, type ResolvedRole } from "../agent/bindings.ts";
import { leastEffort } from "../agent/first-look.ts";
import { gatewayCompletion } from "../agent/safety/judge-model.ts";
import type { SideListener } from "../agent/side/api-model.ts";
import type { KeydClient } from "./client.ts";

const CELL = "quick-model";
// A side question holds its listener for many calls, beside the quick one; a side question that
// finds all of them in use waits for none.
const SIDE_CELLS = ["side-model-0", "side-model-1", "side-model-2", "side-model-3"];

export interface QuickModelDeps {
  keyd: Pick<
    KeydClient,
    | "openCell"
    | "closeCell"
    | "beginPricedTask"
    | "modelAdmission"
    | "setModelAdmission"
    | "endTask"
    | "cell"
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
  readonly #sideCells = new Set<string>();
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
    const listener = await this.#open(CELL, role, undefined, signal);
    try {
      return await gatewayCompletion(
        () => listener.binding,
        () => listener.at,
        this.deps.fetch,
        listener.effort,
      )(system, prompt, signal);
    } finally {
      await listener.close();
    }
  }
  // A listener of a side question's own, for as long as it holds it, with only what is left of its
  // limit to spend. The cost counts against the day as any other, and never against a task.
  async sideListener(
    role: ResolvedRole,
    budgetUSD: number | undefined,
    signal: AbortSignal,
  ): Promise<SideListener> {
    const cell = SIDE_CELLS.find((name) => !this.#sideCells.has(name));
    if (!cell) throw new Error("too many side questions at once");
    this.#sideCells.add(cell);
    try {
      const listener = await this.#open(cell, role, budgetUSD, signal);
      return {
        ...listener,
        close: () => listener.close().finally(() => this.#sideCells.delete(cell)),
      };
    } catch (error) {
      this.#sideCells.delete(cell);
      throw error;
    }
  }
  async #open(
    cellId: string,
    role: ResolvedRole,
    budgetUSD: number | undefined,
    signal: AbortSignal,
  ): Promise<SideListener> {
    signal.throwIfAborted();
    const { keyd } = this.deps;
    const port = this.deps.ports.reserve();
    let opened = false;
    let taskId: string | undefined;
    const close = async (): Promise<number | undefined> => {
      let spent: number | undefined;
      if (opened) {
        // What keyd counted, read while it still holds the task.
        const info = await keyd.cell(cellId).catch(() => undefined);
        if (taskId && info?.task?.id === taskId) spent = info.task.spentUSD;
        await keyd.endTask(cellId).catch(() => {});
        await keyd.closeCell(cellId).catch(() => false);
      }
      this.deps.ports.release(port);
      return spent;
    };
    try {
      // A listener left by an earlier run of the daemon holds a stand-in nobody has any more.
      await keyd.closeCell(cellId).catch(() => false);
      const cell = await keyd.openCell({
        cellId,
        role: "brain",
        port,
        secrets: role.keyId ? [role.keyId] : [],
      });
      opened = true;
      if (cell.port !== port) throw new Error("keyd did not open the quick listener as asked");
      taskId = ulid();
      if (budgetUSD === undefined) await keyd.beginPricedTask(cellId, taskId, pricingOf([role]));
      else await keyd.beginPricedTask(cellId, taskId, pricingOf([role]), budgetUSD);
      const owner = await keyd.modelAdmission(cellId);
      if (owner.taskId !== taskId || owner.retired) throw new Error("quick listener owner changed");
      const open = await keyd.setModelAdmission(cellId, {
        taskId,
        generationId: owner.generationId,
        expectedEpoch: owner.epoch,
        state: "open",
      });
      if (open.taskId !== taskId || open.paused || open.retired)
        throw new Error("quick listener admission was not opened");
      signal.throwIfAborted();
      const effort = leastEffort(
        modelControls(role.providerId, role.model.id, role.model.controls).efforts,
      );
      return {
        binding: bindingOf(role, cell.surrogates ?? {}),
        at: { port, token: cell.proxyToken },
        ...(effort ? { effort } : {}),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
