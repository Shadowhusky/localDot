import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeydClient } from "../../keyd/client.ts";
import {
  KEYD_TESTS,
  type KeydProcess,
  startKeyd,
  TEST_KEYD_PORTS,
} from "../../keyd/testing/keyd-process.ts";
import { keydModelMode, modelModeConfig } from "./model-mode.ts";

let keyd: KeydProcess;
let client: KeydClient;

// A local model needs no key, and no model call is made, so keyd meters nothing for the task.
describe.skipIf(!KEYD_TESTS)("model mode against the real keyd", () => {
  beforeAll(async () => {
    keyd = await startKeyd();
    client = new KeydClient(keyd.socketPath);
  });
  afterAll(async () => {
    await keyd?.stop();
  });

  it("opens the task's model admission, then closes it and takes keyd's meter", async () => {
    const values: Record<string, string> = {
      LOCALDOT_EVAL_MODEL: "lmstudio:fixture-model",
      LOCALDOT_EVAL_SPEND_CAP_USD: "0.5",
    };
    const config = modelModeConfig((name) => values[name]);
    if (!config) throw new Error("no config");
    const cells: string[] = [];
    const watched = {
      ...Object.fromEntries(
        (
          [
            "status",
            "putSecret",
            "beginPricedTask",
            "modelAdmission",
            "setModelAdmission",
            "cell",
            "endTask",
            "closeCell",
          ] as const
        ).map((name) => [name, client[name].bind(client)]),
      ),
      openCell: (req: Parameters<KeydClient["openCell"]>[0]) => {
        cells.push(req.cellId);
        return client.openCell(req);
      },
    };
    const mode = keydModelMode(config, watched as never, TEST_KEYD_PORTS.from, () => undefined);
    const session = await mode.begin();
    const [cellId] = cells;
    if (!cellId) throw new Error("no cell");
    expect(await client.modelAdmission(cellId)).toMatchObject({ paused: false, active: 0 });
    expect((await client.cell(cellId))?.task).toMatchObject({ limitUSD: 0.5, spentUSD: 0 });
    await session.end();
    expect(mode.spentUSD).toBe(0);
    expect(await client.cell(cellId)).toBeUndefined();
  });
});
