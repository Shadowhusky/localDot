import { randomBytes } from "node:crypto";
import type { ModelAdmissionSnapshot, ModelAdmissionWrite } from "@localdot/protocol";
import type { BrainCells } from "../brain-cell.ts";
// Transport fixtures must explicitly create a closed gate and perform the same
// owner/epoch transition as production. No missing adapter grants admission.
export function fixtureModelAdmission(brains: Pick<BrainCells, "open">) {
  const gates = new Map<string, ModelAdmissionSnapshot>();
  const open = brains.open.bind(brains);
  brains.open = async (opts) => {
    const cell = await open(opts);
    gates.set(cell.id, {
      taskId: opts.sessionId,
      generationId: randomBytes(16).toString("hex"),
      epoch: 1,
      paused: true,
      active: 0,
      retired: false,
    });
    return cell;
  };
  return {
    modelAdmission: async (id: string) => {
      const gate = gates.get(id);
      if (!gate) throw new Error("missing fixture model owner");
      return { ...gate };
    },
    setModelAdmission: async (id: string, input: ModelAdmissionWrite) => {
      const gate = gates.get(id);
      if (
        !gate ||
        gate.taskId !== input.taskId ||
        gate.generationId !== input.generationId ||
        gate.retired ||
        (input.expectedEpoch !== undefined && input.expectedEpoch !== gate.epoch) ||
        (input.state === "open" &&
          (!gate.paused || gate.active !== 0 || input.expectedEpoch === undefined))
      )
        throw new Error("stale fixture model owner");
      const next = { ...gate, paused: input.state === "paused", epoch: gate.epoch + 1 };
      gates.set(id, next);
      return { ...next };
    },
  };
}

// Positive Docker fixtures explicitly open only their just-created priced owner.
// This helper has no production caller and cannot reopen an existing or retired gate.
export async function openFixtureBrainGate(
  client: Pick<import("../../keyd/client.ts").KeydClient, "modelAdmission" | "setModelAdmission">,
  cell: Pick<import("../brain-cell.ts").BrainCell, "id">,
  taskId: string,
): Promise<void> {
  const snap = await client.modelAdmission(cell.id);
  if (snap.taskId !== taskId || !snap.paused || snap.active !== 0 || snap.retired)
    throw new Error("fixture initial closed owner required");
  const opened = await client.setModelAdmission(cell.id, {
    taskId,
    generationId: snap.generationId,
    expectedEpoch: snap.epoch,
    state: "open",
  });
  if (
    opened.taskId !== taskId ||
    opened.generationId !== snap.generationId ||
    opened.paused ||
    opened.active !== 0 ||
    opened.retired
  )
    throw new Error("fixture explicit open not confirmed");
}
