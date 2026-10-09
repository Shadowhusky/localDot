import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeydClient } from "../../keyd/client.ts";
import {
  KEYD_TESTS,
  type KeydProcess,
  startKeyd,
  TEST_KEYD_PORTS,
} from "../../keyd/testing/keyd-process.ts";
import { WEB_CELL_ID, WebCell } from "./cell.ts";

describe.skipIf(!KEYD_TESTS)("the web tools' listener on a real keyd", () => {
  let keyd: KeydProcess;
  let client: KeydClient;
  beforeAll(async () => {
    keyd = await startKeyd();
    client = new KeydClient(keyd.socketPath);
  });
  afterAll(async () => {
    await keyd?.stop();
  });

  it("holds no key, intercepts nothing, and keyd still refuses what no cell may reach", async () => {
    let opened: Awaited<ReturnType<KeydClient["cell"]>>;
    const released: number[] = [];
    const cell = new WebCell({
      keyd: {
        openCell: async (request) => {
          const reply = await client.openCell(request);
          opened = await client.cell(request.cellId);
          return reply;
        },
        closeCell: (id) => client.closeCell(id),
      },
      ports: { reserve: () => TEST_KEYD_PORTS.from, release: (port) => void released.push(port) },
    });
    const signal = new AbortController().signal;
    await expect(
      cell.get(new URL("https://intranet.corp/"), { signal, accept: "*/*", maxBytes: 1024 }),
    ).rejects.toThrow("the network rules don't allow it");
    expect(opened).toMatchObject({
      cellId: WEB_CELL_ID,
      role: "browser",
      port: TEST_KEYD_PORTS.from,
    });
    expect(opened?.intercepts ?? []).toEqual([]);
    expect(opened?.surrogates ?? []).toEqual([]);
    expect(await client.cell(WEB_CELL_ID)).toMatchObject({ role: "browser" });
    await cell.close();
    expect(await client.cell(WEB_CELL_ID)).toBeUndefined();
    expect(released).toEqual([TEST_KEYD_PORTS.from]);
    const audit = readFileSync(join(keyd.home, "keyd", "audit.jsonl"), "utf8");
    expect(audit).toMatch(
      /"host":"intranet\.corp[^"]*".*"reason":"host-denied"|"reason":"host-denied".*"host":"intranet\.corp/,
    );
  });
});
