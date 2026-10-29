import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DotInstance, MAIN_DOT_ID } from "../../../../packages/protocol/src/dots.ts";
import {
  applyInstanceEnvironment,
  INSTANCE_FILE,
  InstanceError,
  instanceEnvironment,
  instanceOf,
  keydArguments,
  mainInstance,
  readInstance,
  writeInstance,
} from "./instance.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-instance-"));
  homes.push(dir);
  return dir;
};
const work: DotInstance = {
  v: 1,
  id: "work",
  name: "Work",
  ports: { app: 5750, tool: 5751, keyd: [5760, 5789], preview: [5850, 5865] },
  keychainService: "localdot-keyd.work",
};

describe("a dot's instance file", () => {
  it("is optional: an existing home is the first dot with today's settings", () => {
    const dir = home();
    expect(readInstance(dir)).toBeUndefined();
    expect(instanceOf(dir)).toEqual({
      v: 1,
      id: MAIN_DOT_ID,
      name: "Main",
      ports: { app: 4750, tool: 4751, keyd: [4760, 4789], preview: [4900, 4915] },
      keychainService: "localdot-keyd",
    });
    expect(keydArguments(mainInstance())).toEqual([]);
    expect(instanceEnvironment(mainInstance())).toEqual({
      LOCALDOT_PORT: "4750",
      LOCALDOT_TOOL_PORT: "4751",
      LOCALDOT_KEYD_PORTS: "4760-4789",
      LOCALDOT_PREVIEW_PORTS: "4900-4915",
    });
  });

  it("round-trips privately and gives keyd and the daemon its own settings", () => {
    const dir = home();
    writeInstance(dir, { ...work, publicOrigins: ["https://studio.example.ts.net:5750"] });
    expect(instanceOf(dir).ports.app).toBe(5750);
    expect(keydArguments(instanceOf(dir))).toEqual([
      "-ports",
      "5760-5789",
      "-keychain-service",
      "localdot-keyd.work",
    ]);
    const env: NodeJS.ProcessEnv = { LOCALDOT_PORT: "6000" };
    applyInstanceEnvironment(env, instanceOf(dir));
    expect(env).toEqual({
      LOCALDOT_PORT: "6000",
      LOCALDOT_TOOL_PORT: "5751",
      LOCALDOT_KEYD_PORTS: "5760-5789",
      LOCALDOT_PREVIEW_PORTS: "5850-5865",
      LOCALDOT_PUBLIC_ORIGIN: "https://studio.example.ts.net:5750",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["the first dot's id", JSON.stringify({ ...work, id: "main" })],
    ["overlapping ports", JSON.stringify({ ...work, ports: { ...work.ports, tool: 5760 } })],
    ["another Keychain service", JSON.stringify({ ...work, keychainService: "login" })],
    ["unknown fields", JSON.stringify({ ...work, extra: true })],
  ])("refuses a damaged file (%s) rather than fall back to the first dot's", (_, text) => {
    const dir = home();
    writeFileSync(join(dir, INSTANCE_FILE), text, { mode: 0o600 });
    expect(() => instanceOf(dir)).toThrow(InstanceError);
  });

  it("refuses a file other users could change", () => {
    const dir = home();
    writeInstance(dir, work);
    chmodSync(join(dir, INSTANCE_FILE), 0o666);
    expect(() => readInstance(dir)).toThrow(InstanceError);
  });
});
