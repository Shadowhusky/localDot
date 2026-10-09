import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeydCellInfo, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserKeydClient } from "../keyd/browser-wiring.ts";
import { AccountsProfile } from "./accounts-profile.ts";
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
      if (record?.kind !== "browser") throw new Error("missing owned fixture");
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
    accounts: new AccountsProfile({ home, docker, prefix: "localdot-review-", image: () => "" })
      .volume,
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

describe("independent lifecycle correction boundaries", () => {
  it("fences a cold queued owner before a recovery inventory failure", async () => {
    const f = fixture();
    const damaged = join(f.home, "browser-owners", `${ulid()}.json`);
    writeFileSync(damaged, "{invalid");
    const starting = f.owner.start(f.parent.id);
    const startResult = starting.then(
      () => "resolved",
      () => "rejected",
    );
    const reconciliation = f.owner.reconcile();
    rmSync(damaged);
    await expect(reconciliation).rejects.toThrow();
    expect(await startResult).toBe("rejected");
    expect(f.docker.requests).toEqual([]);
    expect(f.ledger.list()).toEqual([]);
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
  });

  it("aborts admitted bootstrap synchronously and prevents its queued predecessor from restarting", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    f.deps.sendInput = async (_docker, _id, _bytes, signal) => {
      entered.resolve(signal);
      await release.promise;
    };
    const starting = f.owner.start(f.parent.id).then(
      () => "resolved",
      () => "rejected",
    );
    const signal = await entered.promise;
    const queued = f.owner.start(f.parent.id).then(
      () => "resolved",
      () => "rejected",
    );
    const damaged = join(f.home, "browser-owners", `${ulid()}.json`);
    writeFileSync(damaged, "{invalid");
    const reconciliation = f.owner.reconcile();
    const abortedAtCall = signal.aborted;
    rmSync(damaged);
    release.resolve();
    await expect(reconciliation).rejects.toThrow();
    expect(await starting).toBe("rejected");
    expect(await queued).toBe("rejected");
    expect(abortedAtCall).toBe(true);
    expect(f.docker.requests.filter((r) => r.path === "/containers/create")).toHaveLength(2);
    expect(f.docker.containers.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
    f.deps.sendInput = async () => {};
    await f.owner.start(f.parent.id);
    expect(f.owner.endpoints(f.parent.id)).toBeDefined();
    await f.owner.stop(f.parent.id);
  });

  it.each(["delete-error", "absence-error", "still-present"] as const)(
    "attempts independent owners and preserves the profile after %s",
    async (fault) => {
      const f = fixture();
      await f.owner.start(f.parent.id);
      const record = f.ledger.forParent(f.parent.id);
      if (!record?.resources.browser || !record.resources.gate)
        throw new Error("missing fixture ownership");
      const browser = record.resources.browser;
      const gate = record.resources.gate;
      const snapshot = f.docker.containers.get(browser);
      if (!snapshot) throw new Error("missing fixture container");
      let deleted = false;
      f.docker.before = (request) => {
        if (
          request.method === "DELETE" &&
          request.path === `/containers/${browser}` &&
          fault === "delete-error"
        )
          throw new Error("owned removal failed");
        if (
          deleted &&
          request.method === "GET" &&
          request.path === `/containers/${browser}/json` &&
          fault === "absence-error"
        )
          throw new Error("owned absence unavailable");
      };
      f.docker.after = (request) => {
        if (request.method !== "DELETE" || request.path !== `/containers/${browser}`) return;
        deleted = true;
        if (fault === "still-present") f.docker.containers.set(browser, snapshot);
      };
      const start = f.docker.requests.length;
      await expect(f.owner.remove(f.parent.id, { purgeProfile: true })).rejects.toThrow(
        "shutdown could not be confirmed",
      );
      const requests = f.docker.requests.slice(start);
      expect(f.docker.containers.has(gate)).toBe(false);
      expect(
        requests.filter((r) => r.method === "DELETE" && r.path.startsWith("/networks/")),
      ).toHaveLength(2);
      expect(requests.some((r) => r.method === "GET" && r.path === "/containers/json")).toBe(true);
      expect(requests.some((r) => r.method === "DELETE" && r.path.startsWith("/volumes/"))).toBe(
        false,
      );
      expect(f.docker.volumes.size).toBe(1);
      expect(f.ledger.forParent(f.parent.id)?.phase).toBe("failed");
      expect(f.owner.reservedKeydPorts()).toContain(record.keydPort);
      expect(f.owner.endpoints(f.parent.id)).toBeUndefined();
      expect(f.listeners.size).toBe(0);
    },
  );

  it("retains the profile on failed detachment and permits a fresh confirmed retry", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    const record = f.ledger.forParent(f.parent.id);
    if (!record) throw new Error("missing fixture ownership");
    f.docker.before = (request) => {
      if (request.method === "GET" && request.path === "/containers/json")
        throw new Error("detachment unavailable");
    };
    await expect(f.owner.remove(f.parent.id, { purgeProfile: true })).rejects.toThrow(
      "shutdown could not be confirmed",
    );
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.networks.size).toBe(0);
    expect(f.docker.volumes.size).toBe(1);
    expect(f.owner.reservedKeydPorts()).toContain(record.keydPort);
    f.docker.before = undefined;
    await f.owner.remove(f.parent.id, { purgeProfile: true });
    expect([...f.docker.volumes.keys()]).toEqual([f.accounts]);
    expect(f.ledger.list()).toEqual([]);
    expect(f.store.getBrowser(record.id)).toBeUndefined();
  });

  it("purges only after every independent retirement and detachment succeeds", async () => {
    const f = fixture();
    await f.owner.start(f.parent.id);
    await f.owner.remove(f.parent.id, { purgeProfile: true });
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.networks.size).toBe(0);
    expect([...f.docker.volumes.keys()]).toEqual([f.accounts]);
    expect(f.listeners.size).toBe(0);
    expect(f.ledger.list()).toEqual([]);
  });
});
