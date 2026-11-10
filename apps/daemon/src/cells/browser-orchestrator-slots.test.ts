import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeydCellInfo, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserKeydClient } from "../keyd/browser-wiring.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserLedgerStore } from "./browser-ledger.ts";
import { BrowserOrchestrator, type BrowserOrchestratorDeps } from "./browser-orchestrator.ts";
import type { DockerRequest } from "./docker.ts";
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
  const home = mkdtempSync(join(tmpdir(), "browser-slots-"));
  homes.push(home);
  const store = new CellStore(home);
  const parent = sampleRecord();
  store.save(parent);
  const docker = new BrowserDocker();
  const listeners = new Map<string, KeydCellInfo>();
  const keyd: BrowserKeydClient = {
    cell: vi.fn(async (id) => listeners.get(id)),
    openCell: vi.fn(async (request) => {
      listeners.set(request.cellId, {
        cellId: request.cellId,
        role: request.role,
        port: request.port,
        intercepts: [],
        surrogates: [],
      });
      return {
        cellId: request.cellId,
        port: request.port,
        proxyToken: "p".repeat(43),
        caCertPem: certificate,
        caPath: "/private/ca.pem",
        surrogates: {},
      };
    }),
    closeCell: vi.fn(async (id) => listeners.delete(id)),
  };
  const notes: [string, string][] = [];
  const deps: BrowserOrchestratorDeps = {
    home,
    store,
    docker,
    keyd,
    images: { browser: "test/browser:dev", gate: "test/gate:dev" },
    namePrefix: "localdot-test-",
    parentAvailable: () => true,
    externalKeydPorts: () => [4761],
    sendInput: vi.fn(async () => {}),
    supervisor: vi.fn(async (): Promise<unknown> => {
      throw new Error("no supervisor");
    }),
    notify: (key, text) => notes.push([key, text]),
    probe: vi.fn(async (_port, token) => {
      const browser = store
        .inventoryAll()
        .records.find((record) => record.kind === "browser" && record.tokens.browserd === token);
      if (browser?.kind !== "browser") throw new Error("browser record is missing");
      return {
        browserCellId: browser.id,
        parentCellId: browser.parentCellId,
        instance: randomUUID(),
        ready: true,
        holder: "user",
        width: 1280,
        height: 800,
      };
    }),
  };
  const controller = new BrowserOrchestrator(deps);
  const accounts = new AccountsProfile({ home, docker, prefix: "localdot-test-", image: () => "" })
    .volume;
  return {
    home,
    store,
    parent,
    docker,
    keyd,
    listeners,
    controller,
    accounts,
    notes,
    ledger: new BrowserLedgerStore(home, store.keydPorts),
    container: (id: string) => docker.containers.get(id),
    mounts: (id: string) =>
      (docker.containers.get(id)?.Mounts ?? []).map((mount: Record<string, unknown>) => mount.Name),
  };
}

const helpers = (requests: DockerRequest[]) =>
  requests
    .filter((request) => request.method === "POST" && request.path === "/containers/create")
    .map((request) => request.body as { Labels: Record<string, string>; Cmd?: string[] })
    .filter((body) => body.Labels["localdot.role"] === "profile-copy");

describe("a conversation's own browser", () => {
  it("runs beside the main one, on a slot of its own copied from the main slot", async () => {
    const f = fixture();
    const main = await f.controller.start(f.parent.id);
    f.docker.volumes.get(f.accounts)!.syntheticCookie = "signed-in";
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    const own = await f.controller.start(slot);

    expect(own.parentCellId).toBe(f.parent.id);
    expect(own.slot).toBe(slot);
    expect(main.slot).toBeUndefined();
    expect(own.browserCellId).not.toBe(main.browserCellId);
    expect(own.browserd.token).not.toBe(main.browserd.token);
    expect(f.controller.endpoints(f.parent.id)?.browserCellId).toBe(main.browserCellId);
    expect(f.controller.endpoints(slot)?.browserCellId).toBe(own.browserCellId);
    expect(
      f.controller
        .running(f.parent.id)
        .map((ready) => ready.browserCellId)
        .sort(),
    ).toEqual([main.browserCellId, own.browserCellId].sort());

    const ownRecord = f.ledger.forKey(slot)!;
    const mainRecord = f.ledger.forParent(f.parent.id)!;
    expect(ownRecord.keydPort).not.toBe(mainRecord.keydPort);
    expect(f.store.browserFor(f.parent.id, slot)?.id).toBe(own.browserCellId);
    expect(f.store.browserFor(f.parent.id)?.id).toBe(main.browserCellId);
    const volume = `localdot-test-profile-${ownRecord.id}`;
    // Each browser mounts its own profile and nothing else.
    expect(f.mounts(ownRecord.resources.browser!)).toEqual([volume]);
    expect(f.mounts(mainRecord.resources.browser!)).toEqual([f.accounts]);
    expect(f.docker.volumes.get(volume)?.syntheticCookie).toBe("signed-in");
    expect(f.docker.volumes.get(volume)?.Labels).toMatchObject({
      "localdot.role": "profile",
      "localdot.cell": ownRecord.id,
      "localdot.parent": f.parent.id,
    });
    // The main browser keeps running, unpaused.
    expect(f.container(mainRecord.resources.browser!)?.State).toMatchObject({
      Running: true,
      Paused: false,
    });
  });

  it("pauses the main browser only while the profile's own state is copied, read-only", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const mainBrowser = f.ledger.forParent(f.parent.id)!.resources.browser!;
    const seen: { cmd: string; paused: boolean }[] = [];
    f.docker.before = (request) => {
      if (request.method !== "POST" || !request.path.endsWith("/wait")) return;
      const helper = f.docker.containers.get(request.path.split("/")[2]!);
      if (helper?.Config.Labels["localdot.role"] !== "profile-copy") return;
      const script = String(helper.Config.Cmd.at(-1));
      seen.push({
        cmd: helper.Config.Entrypoint[0].endsWith("python3")
          ? "check"
          : script.includes("rm -rf")
            ? "state"
            : "bulk",
        paused: f.container(mainBrowser)?.State.Paused === true,
      });
    };
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    expect(seen).toEqual([
      { cmd: "bulk", paused: false },
      { cmd: "state", paused: true },
      { cmd: "check", paused: false },
    ]);
    for (const body of helpers(f.docker.requests)) {
      const mounts = (body as unknown as { HostConfig: { Mounts: Record<string, unknown>[] } })
        .HostConfig.Mounts;
      for (const mount of mounts)
        if (mount.Source === f.accounts) expect(mount.ReadOnly).toBe(true);
      expect(body).toMatchObject({
        NetworkDisabled: true,
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"] },
      });
    }
    expect(f.container(mainBrowser)?.State.Paused).toBe(false);
  });

  it("copies without a pause when the main browser isn't running", async () => {
    const f = fixture();
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    expect(
      f.docker.requests.some(
        (request) => request.path.endsWith("/pause") || request.path.endsWith("/unpause"),
      ),
    ).toBe(false);
    expect(helpers(f.docker.requests)).toHaveLength(3);
  });

  it("leaves no slot or browser behind when the copy fails, and the main browser running", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const mainBrowser = f.ledger.forParent(f.parent.id)!.resources.browser!;
    f.docker.copyStatus = 30;
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await expect(f.controller.start(slot)).rejects.toThrow(/profile copy/);
    const record = f.ledger.forKey(slot)!;
    expect(f.docker.volumes.has(`localdot-test-profile-${record.id}`)).toBe(false);
    expect(f.controller.endpoints(slot)).toBeUndefined();
    expect(record.resources).toEqual({});
    expect(
      [...f.docker.containers.values()].filter(
        (container) => container.Config.Labels["localdot.role"] === "profile-copy",
      ),
    ).toEqual([]);
    expect(f.container(mainBrowser)?.State).toMatchObject({ Running: true, Paused: false });
    expect(f.controller.endpoints(f.parent.id)).toBeDefined();

    f.docker.copyStatus = 0;
    await expect(f.controller.start(slot)).resolves.toMatchObject({ slot });
  });

  it("keeps the slot when its browser stops, and starts again on it without another copy", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    f.docker.volumes.get(f.accounts)!.syntheticCookie = "first";
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    const volume = `localdot-test-profile-${f.ledger.forKey(slot)!.id}`;
    f.docker.volumes.get(volume)!.syntheticCookie = "signed in here";
    await f.controller.stop(slot);
    expect(f.controller.endpoints(slot)).toBeUndefined();
    expect(f.docker.volumes.has(volume)).toBe(true);
    const copies = helpers(f.docker.requests).length;

    f.docker.volumes.get(f.accounts)!.syntheticCookie = "changed in main";
    const again = await f.controller.start(slot);
    expect(again.slot).toBe(slot);
    expect(helpers(f.docker.requests)).toHaveLength(copies);
    expect(f.docker.volumes.get(volume)?.syntheticCookie).toBe("signed in here");
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBe("changed in main");
  });

  it("removes a conversation's browser with its slot, and leaves the main one alone", async () => {
    const f = fixture();
    const main = await f.controller.start(f.parent.id);
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    const record = f.ledger.forKey(slot)!;
    await f.controller.remove(slot);
    expect(f.ledger.forKey(slot)).toBeUndefined();
    expect(f.store.browserFor(f.parent.id, slot)).toBeUndefined();
    expect(f.docker.volumes.has(`localdot-test-profile-${record.id}`)).toBe(false);
    expect(f.listeners.has(record.id)).toBe(false);
    expect(f.controller.keysOf(f.parent.id)).toEqual([f.parent.id]);
    expect(f.controller.endpoints(f.parent.id)?.instance).toBe(main.instance);
    expect(f.docker.volumes.has(f.accounts)).toBe(true);
  });

  it("stops and removes every browser of a computer with it", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const slots = [ulid(), ulid()];
    for (const slot of slots) {
      f.controller.openSlot(f.parent.id, slot);
      await f.controller.start(slot);
    }
    expect(f.controller.running(f.parent.id)).toHaveLength(3);
    await f.controller.stopComputer(f.parent.id);
    expect(f.controller.running(f.parent.id)).toHaveLength(0);
    expect(
      [...f.docker.containers.values()].filter((container) => container.State.Running),
    ).toEqual([]);
    const volumes = slots.map((slot) => `localdot-test-profile-${f.ledger.forKey(slot)!.id}`);
    for (const volume of volumes) expect(f.docker.volumes.has(volume)).toBe(true);

    await f.controller.removeComputer(f.parent.id);
    for (const volume of volumes) expect(f.docker.volumes.has(volume)).toBe(false);
    expect(f.ledger.list().map((record) => record.slot)).toEqual([undefined]);
    expect(f.docker.volumes.has(f.accounts)).toBe(true);
  });

  it("signing out of everything takes conversations' slots too", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    const volume = `localdot-test-profile-${f.ledger.forKey(slot)!.id}`;
    await f.controller.clearAccounts();
    expect(f.docker.volumes.has(volume)).toBe(false);
    expect(f.ledger.forKey(slot)).toBeUndefined();
    expect(f.controller.endpoints(slot)).toBeUndefined();
  });

  it("names only a computer's main browser as the holder of the saved sign-ins", async () => {
    const f = fixture();
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    expect(f.controller.profileHolder()).toBeUndefined();
    await f.controller.start(f.parent.id);
    expect(f.controller.profileHolder()).toBe(f.parent.id);
  });

  it("recovery after a restart stops every browser and remembers each one's computer", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    await f.controller.start(slot);
    const restarted = new BrowserOrchestrator({
      ...(f.controller as unknown as { deps: BrowserOrchestratorDeps }).deps,
    });
    await restarted.reconcile();
    expect(
      [...f.docker.containers.values()].filter((container) => container.State.Running),
    ).toEqual([]);
    expect(restarted.keysOf(f.parent.id)).toEqual([f.parent.id, slot]);
    expect(restarted.parentOfKey(slot)).toBe(f.parent.id);
    await expect(restarted.start(slot)).resolves.toMatchObject({ slot });
  });

  it("refuses a slot named after a computer or opened for another", () => {
    const f = fixture();
    expect(() => f.controller.openSlot(f.parent.id, f.parent.id)).toThrow();
    const slot = ulid();
    f.controller.openSlot(f.parent.id, slot);
    expect(() => f.controller.openSlot(ulid(), slot)).toThrow();
  });
});
