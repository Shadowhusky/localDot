import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeydCellInfo, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserKeydClient } from "../keyd/browser-wiring.ts";
import { BrowserLedgerStore } from "./browser-ledger.ts";
import { BrowserOrchestrator, type BrowserOrchestratorDeps } from "./browser-orchestrator.ts";
import { CellStore } from "./store.ts";
import { BrowserDocker } from "./testing/browser-docker.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const certificate = readFileSync(
  new URL("../../../../cells/browser/browserd/src/testing/bootstrap-ca.pem", import.meta.url),
  "utf8",
);
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "browser-owner-review-"));
  homes.push(home);
  const store = new CellStore(home);
  const parent = sampleRecord();
  store.save(parent);
  const docker = new BrowserDocker();
  const listeners = new Map<string, KeydCellInfo>();
  const instances = new Map<string, string>();
  const keyd: BrowserKeydClient = {
    cell: async (id) => listeners.get(id),
    openCell: async (request) => {
      listeners.set(request.cellId, {
        cellId: request.cellId,
        role: "browser",
        port: request.port,
        intercepts: [],
        surrogates: [],
      });
      instances.set(request.cellId, randomUUID());
      return {
        cellId: request.cellId,
        port: request.port,
        proxyToken: "p".repeat(43),
        caCertPem: certificate,
        caPath: "/fixture/ca",
        surrogates: {},
      };
    },
    closeCell: vi.fn(async (id) => listeners.delete(id)),
  };
  const deps: BrowserOrchestratorDeps = {
    home,
    store,
    docker,
    keyd,
    images: { browser: "review/browser", gate: "review/gate" },
    namePrefix: "localdot-review-",
    parentAvailable: () => true,
    sendInput: async () => {},
    probe: async (_port, token) => {
      const record = store
        .inventoryAll()
        .records.find((value) => value.kind === "browser" && value.tokens.browserd === token);
      if (!record || record.kind !== "browser") throw new Error("missing owned fixture");
      return {
        browserCellId: record.id,
        parentCellId: record.parentCellId,
        instance: instances.get(record.id),
        ready: true,
        holder: "user",
        width: 1280,
        height: 800,
      };
    },
  };
  const owner = new BrowserOrchestrator(deps);
  return {
    home,
    store,
    parent,
    docker,
    listeners,
    keyd,
    deps,
    owner,
    ledger: new BrowserLedgerStore(home, store.keydPorts),
  };
}

describe("independent browser lifecycle authority", () => {
  it("reserves distinct listeners for concurrent different-parent starts; the later one keeps the sign-ins", async () => {
    const f = fixture();
    f.docker.after = (request, reply) => {
      if (request.path !== "/networks/create") return;
      const network = f.docker.networks.get((reply as { Id: string }).Id);
      if (!network) throw new Error("missing fixture network");
      network.IPAM.Config = [{ Subnet: `10.${f.docker.networks.size}.0.0/16` }];
    };
    const other = sampleRecord();
    f.store.save(other);
    const results = await Promise.allSettled([f.owner.start(f.parent.id), f.owner.start(other.id)]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
    expect(f.owner.endpoints(other.id)).toBeDefined();
    const browserPorts = f.ledger.list().map((record) => record.keydPort);
    expect(new Set(browserPorts).size).toBe(2);
    expect(f.owner.reservedKeydPorts()).toEqual(expect.arrayContaining(browserPorts));
    await f.owner.reconcile();
    expect(f.docker.containers.size).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it("an already-cancelled start allocates neither records nor Docker resources", async () => {
    const f = fixture();
    await expect(f.owner.start(f.parent.id, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(f.ledger.list()).toEqual([]);
    expect(f.docker.requests).toEqual([]);
  });

  it("a queued old start produces no new allocation after Stop revokes its epoch", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.deps.sendInput = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = f.owner.start(f.parent.id);
    const firstResult = first.then(
      () => "resolved",
      () => "rejected",
    );
    await entered.promise;
    const queued = f.owner.start(f.parent.id);
    const queuedResult = queued.then(
      () => "resolved",
      () => "rejected",
    );
    const stopping = f.owner.stop(f.parent.id);
    release.resolve();
    await stopping;
    expect(
      f.docker.requests.filter((request) => request.path === "/containers/create"),
    ).toHaveLength(2);
    expect(await firstResult).toBe("rejected");
    expect(await queuedResult).toBe("rejected");
    expect(f.docker.containers.size).toBe(0);
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
  });

  it("revokes already-published authority before a malformed recovery inventory rejects", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    writeFileSync(join(f.home, "browser-owners", `${ulid()}.json`), "{invalid");
    await expect(f.owner.reconcile()).rejects.toThrow();
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
  });

  it("still retires the independently owned gate after browser deletion fails", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    const record = f.ledger.forParent(f.parent.id);
    if (!record?.resources.browser || !record.resources.gate)
      throw new Error("missing fixture ownership");
    const browser = record.resources.browser;
    const gate = record.resources.gate;
    f.docker.before = (request) => {
      if (request.method === "DELETE" && request.path === `/containers/${browser}`)
        throw new Error("owned browser deletion unavailable");
    };
    await expect(f.owner.stop(f.parent.id)).rejects.toThrow("shutdown could not be confirmed");
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.has(gate)).toBe(false);
    expect(f.docker.containers.has(browser)).toBe(true);
  });

  it("normal Stop falls back from a failed graceful Docker stop and confirms exact resource absence", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    f.docker.before = (request) => {
      if (request.path.endsWith("/stop")) throw new Error("graceful timeout");
    };
    await f.owner.stop(f.parent.id);
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.networks.size).toBe(0);
    expect(f.docker.volumes.size).toBe(1);
    expect(f.listeners.size).toBe(0);
  });

  it("recovers a renamed captured browser by ID without deleting a foreign object", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    const record = f.ledger.forParent(f.parent.id);
    const id = record?.resources.browser;
    if (!id) throw new Error("missing fixture ownership");
    const container = f.docker.containers.get(id);
    if (!container) throw new Error("missing fixture browser");
    container.Name = "/renamed-owned-browser";
    await f.owner.stop(f.parent.id);
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.volumes.size).toBe(1);
  });

  it("refuses deletion when a captured gate has a different owner nonce", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    const gate = [...f.docker.containers.values()].find(
      (value) => value.Config.Labels["localdot.role"] === "gate",
    );
    if (!gate) throw new Error("missing fixture gate");
    gate.Config.Labels["localdot.browser-owner"] = randomUUID();
    const before = f.docker.requests.length;
    await expect(f.owner.stop(f.parent.id)).rejects.toThrow("shutdown could not be confirmed");
    expect(
      f.docker.requests.slice(before).filter((request) => request.method === "DELETE"),
    ).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
});
