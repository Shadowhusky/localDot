import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserLedger, BrowserLedgerStore } from "./browser-ledger.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "browser-ledger-"));
  homes.push(home);
  const store = new BrowserLedgerStore(home, { from: 4760, to: 4789 });
  const record: BrowserLedger = {
    v: 1,
    id: ulid(),
    parentCellId: ulid(),
    owner: randomUUID(),
    createdAt: new Date().toISOString(),
    prefix: "localdot-test-",
    scale: 2,
    keydPort: 4762,
    tokens: { browserd: "a".repeat(43), stream: "b".repeat(43) },
    phase: "provisioning",
    resources: {},
  };
  const path = join(home, "browser-owners", `${record.id}.json`);
  return { home, store, record, path };
}

describe("browser recovery ledger", () => {
  it("persists ownership before resource allocation and reloads privately", () => {
    const f = setup();
    f.store.save(f.record);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.home, "browser-owners")).mode & 0o777).toBe(0o700);
    expect(new BrowserLedgerStore(f.home, f.store.ports).forParent(f.record.parentCellId)).toEqual(
      f.record,
    );
  });
  it.each(["parentCellId", "owner", "prefix", "createdAt"])(
    "refuses reassignment of stable %s",
    (field) => {
      const f = setup();
      f.store.save(f.record);
      const before = readFileSync(f.path);
      const changed = {
        ...f.record,
        [field]:
          field === "parentCellId"
            ? ulid()
            : field === "owner"
              ? randomUUID()
              : field === "prefix"
                ? "other-"
                : "2026-10-01T00:00:00.000Z",
      };
      expect(() => f.store.save(changed)).toThrow("ownership changed");
      expect(readFileSync(f.path)).toEqual(before);
    },
  );
  it("refuses a second browser association and detects an ambiguous on-disk association", () => {
    const f = setup();
    f.store.save(f.record);
    const second = { ...f.record, id: ulid(), owner: randomUUID() };
    expect(() => f.store.save(second)).toThrow("ownership changed");
    writeFileSync(join(f.home, "browser-owners", `${second.id}.json`), JSON.stringify(second));
    expect(() => f.store.list()).toThrow("ambiguous");
  });
  it("fails closed on malformed or extra recovery fields without echoing tokens", () => {
    const f = setup();
    f.store.save(f.record);
    writeFileSync(f.path, JSON.stringify({ ...f.record, hostMount: "/private" }));
    expect(() => f.store.list()).toThrow("record is invalid");
    writeFileSync(f.path, '{"private":"secret-canary');
    try {
      f.store.get(f.record.id);
      throw new Error("accepted malformed data");
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
      expect(String(error)).toContain("record is invalid");
    }
  });
  it("retains exact Docker IDs and rejects path-like or abbreviated ownership", () => {
    const f = setup();
    f.record.resources.browser = "c".repeat(64);
    f.store.save(f.record);
    expect(f.store.get(f.record.id)?.resources.browser).toBe("c".repeat(64));
    for (const value of ["short", "../other", "A".repeat(64)])
      expect(() => f.store.save({ ...f.record, resources: { browser: value } })).toThrow();
  });
  it("rejects self-parenting, invalid port ownership and reused runtime tokens", () => {
    const f = setup();
    for (const record of [
      { ...f.record, parentCellId: f.record.id },
      { ...f.record, keydPort: 4750 },
      { ...f.record, tokens: { browserd: f.record.tokens.stream, stream: f.record.tokens.stream } },
    ])
      expect(() => f.store.save(record)).toThrow();
  });
});
