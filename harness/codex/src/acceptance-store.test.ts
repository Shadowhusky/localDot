import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stampAccount, stampNative } from "./acceptance.ts";
import { readLocalAcceptance, writeLocalAcceptance } from "./acceptance-store.ts";
import { prepareOwnedCodexRoots } from "./roots.ts";

const owned: string[] = [];
const host = { system: "25G83", runtime: "0.0.78" };
function fixture() {
  const top = realpathSync(mkdtempSync("/tmp/localdot-codex-acceptance-"));
  owned.push(top);
  const realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), realHome);
  return { roots, file: join(roots.root, "acceptance.json") };
}
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("this Mac's acceptance record", () => {
  it("round-trips a private record beside the Codex folders and replaces it whole", async () => {
    const f = fixture();
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
    const native = stampNative(undefined, host, "c".repeat(64), 1);
    await writeLocalAcceptance(f.roots, native);
    expect(readLocalAcceptance(f.roots)).toEqual(native);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    const both = stampAccount(native, host, 2);
    await writeLocalAcceptance(f.roots, both);
    expect(readLocalAcceptance(f.roots)).toEqual(both);
    expect(readdirSync(f.roots.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("reads a shared, linked, oversized or malformed record as no record", async () => {
    const f = fixture();
    const record = stampAccount(stampNative(undefined, host, "c".repeat(64), 1), host, 2);
    await writeLocalAcceptance(f.roots, record);
    chmodSync(f.file, 0o644);
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
    chmodSync(f.file, 0o600);
    const other = join(f.roots.root, "..", "other.json");
    linkSync(f.file, other);
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
    rmSync(other);
    rmSync(f.file);
    const elsewhere = join(f.roots.root, "..", "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify(record), { mode: 0o600 });
    symlinkSync(elsewhere, f.file);
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
    rmSync(f.file);
    writeFileSync(f.file, JSON.stringify({ ...record, padding: "x".repeat(5000) }), {
      mode: 0o600,
    });
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
    writeFileSync(f.file, "{", { mode: 0o600 });
    expect(readLocalAcceptance(f.roots)).toBeUndefined();
  });
  it("refuses to write a record that doesn't match the schema", async () => {
    const f = fixture();
    await expect(
      writeLocalAcceptance(f.roots, {
        ...stampNative(undefined, host, "c".repeat(64), 1),
        realAccount: { passed: true } as never,
      }),
    ).rejects.toThrow();
    expect(readdirSync(f.roots.root)).not.toContain("acceptance.json");
  });
});
