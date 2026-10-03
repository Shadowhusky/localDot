import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_FILES, SchemaContractError, schemaContract } from "./contract.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "localdot-schema-fixture-"));
  roots.push(root);
  for (const file of CONTRACT_FILES) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        file === "ServerRequest.json"
          ? {
              oneOf: [
                { properties: { method: { enum: ["b"] } } },
                { properties: { method: { enum: ["a"] } } },
              ],
            }
          : { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
      ),
    );
  }
  return root;
}
describe("pinned schema contract", () => {
  it("covers all 35 required files, sorts server methods, and hashes nested changes", () => {
    const root = fixture(),
      before = schemaContract(root);
    expect(Object.keys(before.files)).toEqual([...CONTRACT_FILES]);
    expect(CONTRACT_FILES).toHaveLength(35);
    expect(Object.isFrozen(CONTRACT_FILES)).toBe(true);
    expect(before.serverRequests).toEqual(["a", "b"]);
    const file = CONTRACT_FILES[1];
    writeFileSync(
      join(root, file),
      JSON.stringify({
        properties: { b: { type: "number" }, a: { type: "string" } },
        type: "object",
      }),
    );
    expect(schemaContract(root)).toEqual(before);
    writeFileSync(
      join(root, file),
      JSON.stringify({
        type: "object",
        properties: { a: { type: "boolean" }, b: { type: "number" } },
      }),
    );
    const after = schemaContract(root);
    expect(after.files[file]).not.toBe(before.files[file]);
    expect(Object.keys(after.files).filter((f) => after.files[f] !== before.files[f])).toEqual([
      file,
    ]);
  });
  it("refuses any missing or malformed required file with safe fixed errors", () => {
    const root = fixture();
    for (const file of CONTRACT_FILES) {
      const path = join(root, file),
        saved = readFileSync(path);
      rmSync(path);
      expect(() => schemaContract(root)).toThrow(SchemaContractError);
      writeFileSync(path, "FAKE-CAPABILITY");
      expect(() => schemaContract(root)).toThrow("Codex schema contract is missing or invalid.");
      writeFileSync(path, saved);
    }
  });
  it.each([
    null,
    [],
    { oneOf: [] },
    { oneOf: [{}] },
    { oneOf: [{ properties: { method: { enum: ["a", "b"] } } }] },
    {
      oneOf: [
        { properties: { method: { enum: ["a"] } } },
        { properties: { method: { enum: ["a"] } } },
      ],
    },
  ])("fails closed on an invalid server-request table %#", (value) => {
    const root = fixture();
    writeFileSync(join(root, "ServerRequest.json"), JSON.stringify(value));
    expect(() => schemaContract(root)).toThrow(SchemaContractError);
  });
  it("retains the exact supplied version, method list, and digest format pending binary acceptance", () => {
    const pin = JSON.parse(
      readFileSync(new URL("../schema/contract-0.154.0.json", import.meta.url), "utf8"),
    );
    expect(pin.codexVersion).toBe("0.154.0");
    expect(Object.keys(pin.files)).toEqual([...CONTRACT_FILES]);
    expect(
      Object.values(pin.files).every(
        (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
      ),
    ).toBe(true);
    expect(pin.serverRequests).toHaveLength(10);
  });
});
