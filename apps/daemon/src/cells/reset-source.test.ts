import { expect, it } from "vitest";
import { ComputerResetSource } from "../../../../packages/protocol/src/computer-reset.ts";
import type { BrowserLedger } from "./browser-ledger.ts";
import { captureComputerResetSource } from "./reset-source.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const id = "01JXYZ00000000000000000001",
  browserId = "01JXYZ00000000000000000002";
function fixture() {
  const cell = {
    ...sampleRecord(id),
    tokens: { desktopd: "x".repeat(43), stream: "y".repeat(43) },
    ownership: {
      desktop: "a".repeat(64),
      gate: "b".repeat(64),
      internalNetwork: "c".repeat(64),
      egressNetwork: "d".repeat(64),
    },
  };
  const browser: BrowserLedger = {
    v: 1,
    id: browserId,
    parentCellId: id,
    owner: "00000000-0000-4000-8000-000000000001",
    prefix: "localdot-",
    createdAt: cell.createdAt,
    scale: 2,
    keydPort: 4780,
    tokens: { browserd: "e".repeat(43), stream: "f".repeat(43) },
    phase: "retained",
    resources: {},
  };
  return { cell, browser };
}
it("captures the retained browser profile even after its executable resources retired", () => {
  const { cell, browser } = fixture(),
    source = captureComputerResetSource(cell, browser);
  expect(source.browser?.owner).toBe(browser.owner);
  expect(source.browser?.resources.workload.id).toBeNull();
  expect(source.browser?.resources.volume).toContain(browserId);
  expect(source.desktop.workload.id).toBe(cell.ownership.desktop);
  const serialized = JSON.stringify(source);
  for (const secret of [...Object.values(cell.tokens), ...Object.values(browser.tokens)])
    expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("keydPort");
  expect(serialized).not.toContain("createdAt");
});
it("records unknown identities explicitly and preserves known identities in a partial creation", () => {
  const { browser } = fixture();
  browser.resources.gate = "b".repeat(64);
  const source = captureComputerResetSource(sampleRecord(id), browser);
  expect(source.desktop.workload.id).toBeNull();
  expect(source.browser?.resources.gate.id).toBe(browser.resources.gate);
  expect(source.browser?.resources.internalNetwork.id).toBeNull();
});
it("rejects cross-computer associations and resource names before producing a reset source", () => {
  const { cell, browser } = fixture();
  expect(() => captureComputerResetSource(cell, { ...browser, parentCellId: browserId })).toThrow();
  expect(() =>
    captureComputerResetSource({
      ...cell,
      docker: { ...cell.docker, homeVolume: "unrelated-home" },
    }),
  ).toThrow();
});
it("rejects duplicate recorded physical identities and extra credential fields", () => {
  const { cell } = fixture(),
    source = captureComputerResetSource(cell);
  expect(
    ComputerResetSource.safeParse({
      ...source,
      desktop: {
        ...source.desktop,
        gate: { ...source.desktop.gate, id: source.desktop.workload.id },
      },
    }).success,
  ).toBe(false);
  expect(ComputerResetSource.safeParse({ ...source, token: "fixture" }).success).toBe(false);
});
