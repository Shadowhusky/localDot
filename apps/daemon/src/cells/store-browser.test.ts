import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellControlConflict, CellOrchestrator } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";
import type { BrowserCellRecord } from "./types.ts";

const faults = vi.hoisted(() => ({ rename: false }));
vi.mock("node:fs", async (load) => {
  const fs = await load<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.rename)
        throw Object.assign(new Error("synthetic rename refusal"), { code: "EIO" });
      return fs.renameSync(...args);
    },
  };
});

const homes: string[] = [];
afterEach(() => {
  faults.rename = false;
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-browser-records-"));
  homes.push(home);
  const store = new CellStore(home),
    parent = sampleRecord();
  store.save(parent);
  const id = ulid();
  const browser: BrowserCellRecord = {
    v: 2,
    kind: "browser",
    id,
    parentCellId: parent.id,
    createdAt: parent.createdAt,
    scale: 2,
    keydPort: 4761,
    tokens: { browserd: "b".repeat(43), stream: "s".repeat(43) },
    docker: {
      internalNetwork: `localdot-cell-${id}`,
      egressNetwork: `localdot-egress-${id}`,
      profileVolume: `localdot-profile-${id}`,
      gate: `localdot-gate-${id}`,
      browser: `localdot-browser-${id}`,
      gateInternalIp: "172.26.0.10",
      gateEgressIp: "172.27.0.10",
      browserIp: "172.26.0.11",
    },
  };
  const file = (cellId: string) => join(home, "cells", cellId, "cell.json");
  const raw = (cellId: string, value: unknown) => {
    mkdirSync(join(home, "cells", cellId), { recursive: true });
    writeFileSync(file(cellId), JSON.stringify(value));
  };
  return { home, store, parent, browser, file, raw };
}

describe("versioned desktop and browser records", () => {
  it("migrates a legacy desktop atomically without changing identity, credentials or ownership", () => {
    const f = fixture();
    const { kind: _kind, ...fields } = f.parent;
    const legacy = {
      ...fields,
      v: 1,
      ownership: {
        desktop: "desktop-owned",
        gate: "gate-owned",
        internalNetwork: "internal-owned",
        egressNetwork: "egress-owned",
      },
    };
    f.raw(f.parent.id, legacy);
    const migrated = f.store.get(f.parent.id);
    expect(migrated).toEqual({ ...legacy, v: 2, kind: "desktop" });
    expect(JSON.parse(readFileSync(f.file(f.parent.id), "utf8"))).toEqual(migrated);
    expect(statSync(f.file(f.parent.id)).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.store.folder(f.parent.id))).toEqual(["cell.json"]);
  });

  it("keeps the original legacy bytes and refuses admission if migration cannot replace them", () => {
    const f = fixture();
    const { kind: _kind, ...fields } = f.parent;
    f.raw(f.parent.id, { ...fields, v: 1 });
    const before = readFileSync(f.file(f.parent.id));
    faults.rename = true;
    expect(() => f.store.get(f.parent.id)).toThrow("rename refusal");
    expect(readFileSync(f.file(f.parent.id))).toEqual(before);
    expect(readdirSync(f.store.folder(f.parent.id))).toEqual(["cell.json"]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(f.store.inventoryAll()).toEqual({ records: [], skipped: [f.parent.id] });
    expect(log.mock.calls.flat().join(" ")).not.toContain(f.parent.tokens.desktopd);
  });

  it.each(["kind", "parentCellId", "mounts", "ownershipExtra"])(
    "refuses an ambiguous legacy %s field without rewriting",
    (field) => {
      const f = fixture();
      const { kind: _kind, ...fields } = f.parent;
      const value = { ...fields, v: 1, [field]: "untrusted" };
      f.raw(f.parent.id, value);
      const before = readFileSync(f.file(f.parent.id));
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(f.store.getStored(f.parent.id)).toBeUndefined();
      expect(readFileSync(f.file(f.parent.id))).toEqual(before);
    },
  );

  it("retains one private browser profile across store reload without exposing it to desktop callers", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const reloaded = new CellStore(f.home);
    expect(reloaded.getBrowser(f.browser.id)).toEqual(f.browser);
    expect(reloaded.browserFor(f.parent.id)).toEqual(f.browser);
    expect(reloaded.get(f.browser.id)).toBeUndefined();
    expect(reloaded.getBrowser(f.parent.id)).toBeUndefined();
    expect(reloaded.list()).toEqual([f.parent]);
    expect(reloaded.inventoryAll().records).toHaveLength(2);
    expect(statSync(f.file(f.browser.id)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["unknown root", (r: BrowserCellRecord) => ({ ...r, mount: "/private" })],
    [
      "desktop volume",
      (r: BrowserCellRecord) => ({ ...r, docker: { ...r.docker, homeVolume: "other" } }),
    ],
    [
      "desktop token",
      (r: BrowserCellRecord) => ({ ...r, tokens: { ...r.tokens, desktopd: "d".repeat(43) } }),
    ],
    [
      "ownership extra",
      (r: BrowserCellRecord) => ({
        ...r,
        ownership: {
          browser: "a",
          gate: "b",
          internalNetwork: "c",
          egressNetwork: "d",
          profilePath: "/private",
        },
      }),
    ],
    ["self parent", (r: BrowserCellRecord) => ({ ...r, parentCellId: r.id })],
    ["malformed parent", (r: BrowserCellRecord) => ({ ...r, parentCellId: "../other" })],
    [
      "foreign profile",
      (r: BrowserCellRecord) => ({
        ...r,
        docker: { ...r.docker, profileVolume: `localdot-profile-${ulid()}` },
      }),
    ],
    [
      "same stream credential",
      (r: BrowserCellRecord) => ({ ...r, tokens: { ...r.tokens, stream: r.tokens.browserd } }),
    ],
    [
      "missing browser",
      (r: BrowserCellRecord) => ({ ...r, docker: { ...r.docker, browser: undefined } }),
    ],
    ["missing kind", (r: BrowserCellRecord) => ({ ...r, kind: undefined })],
  ] as const)("refuses %s before accepting persisted browser data", (_name, edit) => {
    const f = fixture();
    const value = edit(f.browser);
    f.raw(f.browser.id, value);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(f.store.getStored(f.browser.id)).toBeUndefined();
    expect(() => f.store.saveBrowser(value as BrowserCellRecord)).toThrow();
    expect(JSON.parse(readFileSync(f.file(f.browser.id), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(value)),
    );
  });

  it("refuses a missing or browser parent", () => {
    const f = fixture();
    expect(() => f.store.saveBrowser({ ...f.browser, parentCellId: ulid() })).toThrow(
      "parent is unavailable",
    );
    f.store.saveBrowser(f.browser);
    const other = fixture();
    expect(() => f.store.saveBrowser({ ...other.browser, parentCellId: f.browser.id })).toThrow(
      "parent is unavailable",
    );
  });

  it("allows refreshing the owned browser runtime while preserving its profile association", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const updated: BrowserCellRecord = {
      ...f.browser,
      tokens: { browserd: "n".repeat(43), stream: "t".repeat(43) },
      ownership: {
        browser: "new-browser",
        gate: "new-gate",
        internalNetwork: "new-internal",
        egressNetwork: "new-egress",
      },
    };
    f.store.saveBrowser(updated);
    expect(new CellStore(f.home).browserFor(f.parent.id)).toEqual(updated);
  });

  it("never lets a desktop save replace a browser identity", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    expect(() => f.store.save(sampleRecord(f.browser.id))).toThrow("identity is already owned");
    expect(f.store.getBrowser(f.browser.id)).toEqual(f.browser);
  });

  it("refuses duplicate profiles and profile or parent reassignment", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const other = fixture();
    expect(() => f.store.saveBrowser({ ...other.browser, parentCellId: f.parent.id })).toThrow(
      "profile already exists",
    );
    f.store.save(other.parent);
    expect(() => f.store.saveBrowser({ ...f.browser, parentCellId: other.parent.id })).toThrow(
      "identity is already owned",
    );
    expect(() =>
      f.store.saveBrowser({
        ...f.browser,
        docker: { ...f.browser.docker, profileVolume: `other-profile-${f.browser.id}` },
      }),
    ).toThrow("identity is already owned");
    expect(f.store.browserFor(f.parent.id)).toEqual(f.browser);
  });

  it("refuses persisted ambiguity and never overwrites an unreadable cell identity", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const other = fixture();
    f.raw(other.browser.id, { ...other.browser, parentCellId: f.parent.id });
    expect(() => f.store.browserFor(f.parent.id)).toThrow("ambiguous");
    const broken = fixture();
    broken.raw(broken.browser.id, { v: 2, secret: "private-canary" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => broken.store.saveBrowser(broken.browser)).toThrow("identity cannot be confirmed");
    expect(readFileSync(broken.file(broken.browser.id), "utf8")).toContain("private-canary");
  });

  it("desktop lifecycle never adopts or deletes a valid browser record and reserves its keyd port", async () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const docker = new DockerClient("/not-a-real-docker-socket"),
      request = vi.spyOn(docker, "request");
    const orchestrator = new CellOrchestrator({
      docker,
      store: f.store,
      images: { desktop: "desktop", gate: "gate" },
      probeDesktopd: async () => undefined,
      probeStream: async () => false,
      permanentFence: (id) => id === f.browser.id,
    });
    try {
      expect(orchestrator.list().map((r) => r.id)).toEqual([f.parent.id]);
      expect(orchestrator.record(f.browser.id)).toBeUndefined();
      expect(orchestrator.endpoints(f.browser.id)).toBeUndefined();
      expect(new Set(orchestrator.reservedKeydPorts())).toEqual(new Set([4760, 4761]));
      for (const action of [
        () => orchestrator.start(f.browser.id),
        () => orchestrator.stop(f.browser.id),
        () => orchestrator.remove(f.browser.id, { purgeHome: true }),
      ])
        await expect(action()).rejects.toThrow();
      await expect(orchestrator.create({ id: f.browser.id, scale: 2 })).rejects.toBeInstanceOf(
        CellControlConflict,
      );
      await orchestrator.containFenced();
      expect(request).not.toHaveBeenCalled();
      expect(f.store.getBrowser(f.browser.id)).toEqual(f.browser);
      expect(existsSync(f.file(f.browser.id))).toBe(true);
    } finally {
      orchestrator.dispose();
    }
  });
});
