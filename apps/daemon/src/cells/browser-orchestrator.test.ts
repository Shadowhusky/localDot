import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydCellInfo } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserKeydClient } from "../keyd/browser-wiring.ts";
import { KeydError } from "../keyd/client.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserLedgerStore, BrowserStartCancelled } from "./browser-ledger.ts";
import {
  BROWSER_BACK,
  BrowserOrchestrator,
  type BrowserOrchestratorDeps,
} from "./browser-orchestrator.ts";
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
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "browser-lifecycle-"));
  homes.push(home);
  const store = new CellStore(home);
  const parent = sampleRecord();
  store.save(parent);
  const docker = new BrowserDocker();
  const listeners = new Map<string, KeydCellInfo>();
  const keyd: BrowserKeydClient = {
    cell: vi.fn(async (id) => listeners.get(id)),
    openCell: vi.fn(async (request) => {
      expect(request.role).toBe("browser");
      expect(request.secrets).toEqual([]);
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
  let available = true,
    instance = randomUUID();
  let received: Buffer | undefined;
  const deps: BrowserOrchestratorDeps = {
    home,
    store,
    docker,
    keyd,
    images: { browser: "test/browser:dev", gate: "test/gate:dev" },
    namePrefix: "localdot-test-",
    parentAvailable: () => available,
    externalKeydPorts: () => [4761],
    sendInput: vi.fn(async (_docker, container, material) => {
      expect(docker.containers.get(container)?.State.Running).toBe(true);
      received = material;
      const value = JSON.parse(material.toString());
      expect(store.browserFor(value.parentCellId)).toBeDefined();
      expect(value.proxyToken).toBe("p".repeat(43));
    }),
    supervisor: vi.fn(async (): Promise<unknown> => {
      throw new Error("an older browser image has no supervisor report");
    }),
    probe: vi.fn(async (_port, token) => {
      const browser = store
        .inventoryAll()
        .records.find((record) => record.kind === "browser" && record.tokens.browserd === token);
      if (browser?.kind !== "browser") throw new Error("browser record is missing");
      return {
        browserCellId: browser.id,
        parentCellId: browser.parentCellId,
        instance,
        ready: true,
        holder: "user",
        width: 1280,
        height: 800,
      };
    }),
  };
  const controller = new BrowserOrchestrator(deps);
  const ledger = new BrowserLedgerStore(home, store.keydPorts);
  return {
    accounts: new AccountsProfile({ home, docker, prefix: "localdot-test-", image: () => "" })
      .volume,
    home,
    store,
    parent,
    docker,
    listeners,
    keyd,
    deps,
    controller,
    ledger,
    buffer: () => received,
    nextInstance: () => {
      instance = randomUUID();
    },
    unavailable: () => {
      available = false;
    },
  };
}

// A profile one of this install's browser cells kept for itself before sign-ins were shared.
function legacyProfile(f: ReturnType<typeof fixture>, cookie: string): string {
  const owner = randomUUID();
  const id = "01JXYZ0000000000000000000B";
  f.ledger.save({
    v: 1,
    id,
    parentCellId: f.parent.id,
    owner,
    prefix: "localdot-test-",
    createdAt: new Date().toISOString(),
    scale: 2,
    keydPort: 4762,
    tokens: { browserd: "x".repeat(43), stream: "y".repeat(43) },
    resources: {},
    phase: "stopped",
  });
  const legacy = `localdot-test-profile-${id}`;
  f.docker.volumes.set(legacy, {
    Name: legacy,
    Labels: {
      "localdot.cell": id,
      "localdot.parent": f.parent.id,
      "localdot.role": "profile",
      "localdot.browser-owner": owner,
    },
    CreatedAt: "2026-01-01T00:00:00Z",
    syntheticCookie: cookie,
  });
  return legacy;
}

describe("persistent browser lifecycle", () => {
  it("creates an isolated browser and publishes only its authenticated, user-held fresh instance", async () => {
    const f = fixture();
    const ready = await f.controller.start(f.parent.id);
    expect(ready.parentCellId).toBe(f.parent.id);
    expect(f.controller.get(f.parent.id)?.state).toBe("ready");
    expect(f.controller.endpoints(f.parent.id)).toEqual(ready);
    expect(ready.stream.authorization).toBe(
      `Basic ${Buffer.from(`localdot:${f.store.browserFor(f.parent.id)?.tokens.stream}`).toString("base64")}`,
    );
    expect(f.ledger.forParent(f.parent.id)?.keydPort).toBe(4762);
    expect(f.buffer()?.every((byte) => byte === 0)).toBe(true);
    const requests = JSON.stringify(f.docker.requests);
    expect(requests).not.toContain("p".repeat(43));
    expect(requests).not.toContain("BEGIN CERTIFICATE");
    ready.browserd.token = "changed";
    expect(f.controller.endpoints(f.parent.id)?.browserd.token).not.toBe("changed");
  });

  it("tells whether the running browser still answers as ready", async () => {
    const f = fixture();
    expect(await f.controller.health(f.parent.id)).toBeUndefined();
    const ready = await f.controller.start(f.parent.id);
    expect(await f.controller.health(f.parent.id)).toBe("ready");
    const probe = vi.mocked(f.deps.probe);
    if (!probe) throw new Error("the probe is missing");
    probe.mockResolvedValueOnce({
      browserCellId: ready.browserCellId,
      parentCellId: ready.parentCellId,
      instance: ready.instance,
      ready: false,
      holder: "user",
      width: 1280,
      height: 800,
    });
    expect(await f.controller.health(f.parent.id)).toBe("unready");
    probe.mockResolvedValueOnce({
      browserCellId: ready.browserCellId,
      parentCellId: ready.parentCellId,
      instance: randomUUID(),
      ready: true,
      holder: "user",
      width: 1280,
      height: 800,
    });
    expect(await f.controller.health(f.parent.id)).toBe("unready");
    probe.mockRejectedValueOnce(new Error("connection refused"));
    expect(await f.controller.health(f.parent.id)).toBe("silent");
  });

  it("waits for a browser restarting its Chromium in place and says what failed", async () => {
    const f = fixture();
    const ready = await f.controller.start(f.parent.id);
    const probe = vi.mocked(f.deps.probe);
    const supervisor = vi.mocked(f.deps.supervisor);
    if (!probe || !supervisor) throw new Error("the probes are missing");
    const unready = {
      browserCellId: ready.browserCellId,
      parentCellId: ready.parentCellId,
      instance: ready.instance,
      ready: false,
      holder: "user",
      width: 1280,
      height: 800,
    };
    const failure = {
      kind: "browser_exited",
      detail: "exited on SIGKILL, out of memory",
      recovered: true,
      at: "2026-10-26T12:00:00.000Z",
    };
    probe.mockResolvedValueOnce(unready);
    supervisor.mockResolvedValueOnce({ state: "restarting", restarts: 0, lastFailure: failure });
    expect(await f.controller.health(f.parent.id)).toBe("restarting");
    probe.mockResolvedValueOnce(unready);
    supervisor.mockResolvedValueOnce({
      state: "stopped",
      restarts: 3,
      lastFailure: { ...failure, recovered: false },
    });
    expect(await f.controller.health(f.parent.id)).toBe("unready");
    supervisor.mockResolvedValueOnce({ state: "running", restarts: 1, lastFailure: failure });
    expect(await f.controller.status(f.parent.id)).toEqual({
      state: "ready",
      restarts: 1,
      problem: "The browser process ended (exited on SIGKILL, out of memory) and was restarted.",
      problemAt: failure.at,
    });
    f.controller.noteProblem(f.parent.id, "You restarted the web browser.");
    expect(await f.controller.status(f.parent.id)).toMatchObject({
      state: "ready",
      restarts: 0,
      problem: "You restarted the web browser.",
    });
    f.unavailable();
    expect(await f.controller.status(f.parent.id)).toEqual({
      state: "off",
      reason: "computer-stopped",
      problem: "The computer is not running.",
      clears: "Start the computer; the web browser starts with it.",
    });
  });

  it("names why a browser could not start: its exit, memory and browserd's own words", async () => {
    const f = fixture();
    const probe = vi.mocked(f.deps.probe);
    if (!probe) throw new Error("the probe is missing");
    probe.mockImplementationOnce(async () => {
      const browser = [...f.docker.containers.values()].find(
        (container) => container.Config.Labels["localdot.role"] === "browser",
      );
      if (!browser) throw new Error("the browser container is missing");
      browser.State = { Running: false, Paused: false, ExitCode: 1, OOMKilled: true };
      throw new Error("connection refused");
    });
    const original = f.docker.request.bind(f.docker);
    const frame = (text: string) => {
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    f.docker.request = (async (request: Parameters<BrowserDocker["request"]>[0]) =>
      request.path.endsWith("/logs")
        ? Buffer.concat([
            frame("Selkies: private-page-canary\n"),
            frame("browserd: could not start Chromium\n"),
          ])
        : original(request)) as BrowserDocker["request"];
    await expect(f.controller.start(f.parent.id)).rejects.toThrow(
      "Browser start failed during readiness (Browser process exited during startup; the browser container exited with code 1; it ran out of memory; browserd: could not start Chromium); its profile has been retained",
    );
  });

  it("serializes concurrent starts into one profile and one running browser", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.controller.start(f.parent.id),
      f.controller.start(f.parent.id),
    ]);
    expect(first).toEqual(second);
    expect(f.docker.volumes.size).toBe(1);
    expect(f.keyd.openCell).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved sign-ins through a browser restart, a daemon restart and a new computer", async () => {
    const f = fixture();
    const mounted = () =>
      f.docker.requests
        .filter((request) => request.path === "/containers/create")
        .map((request) => request.body as { Hostname?: string; HostConfig: { Mounts?: object[] } })
        .filter((spec) => spec.Hostname)
        .map((spec) => spec.HostConfig.Mounts);
    await f.controller.start(f.parent.id);
    const accounts = f.docker.volumes.get(f.accounts);
    if (!accounts) throw new Error("the shared profile is missing");
    accounts.syntheticCookie = "signed-in";
    await f.controller.stop(f.parent.id);
    const restarted = new BrowserOrchestrator(f.deps);
    await restarted.reconcile();
    f.nextInstance();
    await restarted.start(f.parent.id);
    await restarted.remove(f.parent.id);
    const replacement = sampleRecord();
    f.store.save(replacement);
    f.nextInstance();
    const next = await restarted.start(replacement.id);
    expect(next.parentCellId).toBe(replacement.id);
    expect([...f.docker.volumes.values()]).toEqual([accounts]);
    expect(accounts.syntheticCookie).toBe("signed-in");
    expect(mounted()).toEqual(
      Array(3).fill([{ Type: "volume", Source: f.accounts, Target: "/profile" }]),
    );
    const holders = f.docker.requests
      .filter((request) => request.path === "/containers/create")
      .map((request) => request.body as { Labels: Record<string, string>; HostConfig: object })
      .filter((spec) => JSON.stringify(spec.HostConfig).includes(f.accounts));
    expect(new Set(holders.map((spec) => spec.Labels["localdot.role"]))).toEqual(
      new Set(["browser"]),
    );
  });

  it("moves the computer's existing browser profile into the shared one on first start", async () => {
    const f = fixture();
    const legacy = legacyProfile(f, "from-before");
    await f.controller.start(f.parent.id);
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBe("from-before");
    expect(f.docker.volumes.get(legacy)?.syntheticCookie).toBe("from-before");
  });

  it("never fills the sign-ins from a profile another install left on the same Docker", async () => {
    const f = fixture();
    const foreign = "localdot-test-profile-01JXYZ0000000000000000000F";
    f.docker.volumes.set(foreign, {
      Name: foreign,
      Labels: { "localdot.cell": "01JXYZ0000000000000000000F", "localdot.role": "profile" },
      CreatedAt: "2026-01-01T00:00:00Z",
      syntheticCookie: "someone-else",
    });
    await f.controller.start(f.parent.id);
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBeUndefined();
    expect(f.docker.volumes.get(foreign)?.syntheticCookie).toBe("someone-else");
  });

  it("leaves no profile with old sign-ins behind on Clear all", async () => {
    const f = fixture();
    legacyProfile(f, "from-before");
    await f.controller.start(f.parent.id);
    await f.controller.clearAccounts();
    expect([...f.docker.volumes.keys()]).toEqual([f.accounts]);
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBeUndefined();
    f.nextInstance();
    await f.controller.start(f.parent.id);
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBeUndefined();
  });

  it("lets Clear all go ahead of a Replace computer still waiting to copy old sign-ins", async () => {
    const f = fixture();
    const legacy = legacyProfile(f, "from-before");
    const source = f.controller.resetSource(f.parent.id);
    f.unavailable();
    const retire = vi.fn(async () => {});
    const cleared = f.controller.clearAccounts();
    const reset = f.controller.retireReset(f.parent.id, source, retire);
    const outcome = await Promise.race([
      Promise.allSettled([cleared, reset]),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 2000)),
    ]);
    expect(outcome).not.toBe("stuck");
    await expect(cleared).resolves.toBeUndefined();
    await expect(reset).rejects.toThrow("cancelled");
    expect(retire).not.toHaveBeenCalled();
    expect(f.docker.volumes.has(legacy)).toBe(false);
  });

  it("stops counting a removed computer as holding the sign-ins after recovery", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    expect(f.controller.profileHolder()).toBe(f.parent.id);
    await f.controller.remove(f.parent.id, { purgeProfile: true });
    await f.controller.reconcile();
    expect(f.controller.profileHolder()).toBeUndefined();
  });

  it("counts a browser whose stop could not be confirmed as still holding the sign-ins", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    f.docker.before = (request) => {
      if (request.method === "DELETE" && request.path.startsWith("/containers/"))
        throw new Error("synthetic docker failure");
    };
    await expect(f.controller.stop(f.parent.id)).rejects.toThrow("could not be confirmed");
    expect(f.controller.profileHolder()).toBe(f.parent.id);
  });

  it("lets go of the sign-ins and starts them again empty on Clear all", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const accounts = f.docker.volumes.get(f.accounts);
    if (!accounts) throw new Error("the shared profile is missing");
    accounts.syntheticCookie = "signed-in";
    await f.controller.clearAccounts();
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.volumes.get(f.accounts)?.syntheticCookie).toBeUndefined();
    f.nextInstance();
    await f.controller.start(f.parent.id);
  });

  it("Stop removes executable resources and closes the listener; restart reuses the profile with new runtime tokens", async () => {
    const f = fixture();
    const first = await f.controller.start(f.parent.id);
    const profile = [...f.docker.volumes.values()][0];
    if (!profile) throw new Error("profile is missing");
    profile.syntheticCookie = "private-fixture";
    await f.controller.stop(f.parent.id);
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.networks.size).toBe(0);
    f.nextInstance();
    const second = await f.controller.start(f.parent.id);
    expect(second.browserCellId).toBe(first.browserCellId);
    expect(second.instance).not.toBe(first.instance);
    expect(second.browserd.token).not.toBe(first.browserd.token);
    expect([...f.docker.volumes.values()]).toEqual([profile]);
  });

  it("cancels a pending start before material delivery and suppresses queued old starts", async () => {
    const f = fixture();
    const entered = deferred(),
      resume = deferred();
    f.docker.before = async (request) => {
      if (request.path.endsWith("/start")) {
        entered.resolve();
        await resume.promise;
      }
    };
    const start = f.controller.start(f.parent.id);
    const rejected = expect(start).rejects.toThrow(BrowserStartCancelled);
    const queued = f.controller.start(f.parent.id);
    const queuedRejected = expect(queued).rejects.toThrow("cancelled");
    await entered.promise;
    const stop = f.controller.stop(f.parent.id);
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    resume.resolve();
    await Promise.all([rejected, queuedRejected, stop]);
    expect(f.deps.sendInput).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.size).toBe(0);
  });

  it("contains a lost create reply by its saved unique ownership without publishing", async () => {
    const f = fixture();
    f.docker.after = (request) => {
      if (request.path === "/containers/create") throw new Error("reply lost");
    };
    await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.networks.size).toBe(0);
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    expect(f.controller.reservedKeydPorts()).toContain(4762);
  });

  it.each(["parent", "instance", "holder", "extra", "width"])(
    "refuses the wrong health %s and drains the runtime",
    async (fault) => {
      const f = fixture();
      const original = f.deps.probe;
      if (!original) throw new Error("health fixture is missing");
      f.deps.probe = async (...args) => {
        const value = (await original(...args)) as Record<string, unknown>;
        if (fault === "parent") value.parentCellId = sampleRecord().id;
        if (fault === "instance") value.instance = "not-a-uuid";
        if (fault === "holder") value.holder = "agent";
        if (fault === "extra") value.cookie = "forbidden";
        if (fault === "width") value.width = 2560;
        return value;
      };
      await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
      expect(f.listeners.size).toBe(0);
      expect(f.docker.containers.size).toBe(0);
      expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    },
  );

  it("refuses a stale process instance after restart", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    await f.controller.stop(f.parent.id);
    await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    expect(f.listeners.size).toBe(0);
  });

  it("keeps endpoints private until a not-ready health reply becomes ready", async () => {
    const f = fixture();
    const original = f.deps.probe;
    if (!original) throw new Error("health fixture is missing");
    let calls = 0;
    f.deps.probe = async (...args) => {
      expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
      return { ...((await original(...args)) as object), ready: ++calls > 1 };
    };
    await f.controller.start(f.parent.id);
    expect(calls).toBe(2);
  });

  it("keeps the saved sign-ins through remove, recreate and purge of a computer's browser", async () => {
    const f = fixture();
    const first = await f.controller.start(f.parent.id);
    await f.controller.remove(f.parent.id);
    expect(f.store.browserFor(f.parent.id)).toBeUndefined();
    expect([...f.docker.volumes.keys()]).toEqual([f.accounts]);
    expect(f.controller.reservedKeydPorts()).not.toContain(4762);
    f.nextInstance();
    expect((await f.controller.start(f.parent.id)).browserCellId).toBe(first.browserCellId);
    await f.controller.remove(f.parent.id, { purgeProfile: true });
    expect([...f.docker.volumes.keys()]).toEqual([f.accounts]);
    expect(f.ledger.list()).toEqual([]);
  });

  it("reconciliation fences a former running instance without adopting its endpoints", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const restarted = new BrowserOrchestrator(f.deps);
    expect(restarted.endpoints(f.parent.id)).toBeUndefined();
    await restarted.reconcile();
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.volumes.size).toBe(1);
    f.nextInstance();
    await restarted.start(f.parent.id);
  });

  it("withholds endpoints as soon as the parent is unavailable", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    f.unavailable();
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    await expect(f.controller.start(f.parent.id)).rejects.toThrow("cancelled");
    await f.controller.stop(f.parent.id);
    expect(f.listeners.size).toBe(0);
  });

  it("cleans containers independently of a failed keyd close and retains its listener reservation", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    f.keyd.closeCell = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await expect(f.controller.stop(f.parent.id)).rejects.toThrow("shutdown could not be confirmed");
    expect(f.docker.containers.size).toBe(0);
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
    expect(f.controller.reservedKeydPorts()).toContain(4762);
  });

  it("does not delete any resource when an ownership label changed", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    const container = [...f.docker.containers.values()][0];
    if (!container) throw new Error("container is missing");
    container.Config.Labels["localdot.parent"] = sampleRecord().id;
    const index = f.docker.requests.length;
    await expect(f.controller.stop(f.parent.id)).rejects.toThrow("shutdown could not be confirmed");
    expect(f.docker.requests.slice(index).filter((request) => request.method === "DELETE")).toEqual(
      [],
    );
    expect(f.listeners.size).toBe(0);
  });

  it("refuses to open the saved sign-ins while a foreign container has them mounted", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    await f.controller.stop(f.parent.id);
    const profile = [...f.docker.volumes.keys()][0];
    f.docker.containers.set("f".repeat(64), {
      Id: "f".repeat(64),
      Name: "/foreign",
      Mounts: [{ Name: profile }],
    });
    await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
    await expect(f.controller.clearAccounts()).rejects.toThrow("in use");
    expect(f.docker.volumes.size).toBe(1);
    expect(f.docker.containers.has("f".repeat(64))).toBe(true);
  });

  it.each(["public-port", "extra-port", "extra-network", "internal-gateway"])(
    "rejects altered actual network state: %s",
    async (fault) => {
      const f = fixture();
      f.docker.after = (request) => {
        if (request.path === "/networks/create" && fault === "internal-gateway") {
          for (const network of f.docker.networks.values())
            if (network.Internal) network.IPAM.Config[0].Gateway = "172.30.0.1";
        }
        if (request.path.endsWith("/start")) {
          for (const container of f.docker.containers.values()) {
            if (fault === "public-port" && container.NetworkSettings.Ports["8081/tcp"])
              container.NetworkSettings.Ports["8081/tcp"][0].HostIp = "0.0.0.0";
            if (fault === "extra-port")
              container.NetworkSettings.Ports["9222/tcp"] = [
                { HostIp: "127.0.0.1", HostPort: "49222" },
              ];
            if (fault === "extra-network")
              container.NetworkSettings.Networks.foreign = {
                NetworkID: "f".repeat(64),
                IPAddress: "192.168.1.1",
              };
          }
        }
      };
      await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
      expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
      expect(f.listeners.size).toBe(0);
    },
  );

  it("retains a stable browser hostname across physical container replacements", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    await f.controller.stop(f.parent.id);
    f.nextInstance();
    await f.controller.start(f.parent.id);
    const specs = f.docker.requests
      .filter((request) => request.path === "/containers/create")
      .map((request) => request.body as { Hostname?: string })
      .filter((spec) => spec.Hostname);
    expect(specs).toHaveLength(2);
    expect(specs[0]?.Hostname).toBe(specs[1]?.Hostname);
    expect(specs[0]?.Hostname).toMatch(/^browser-[0-9a-z]{26}$/u);
  });

  it("streams the browser screen 4:2:0 unless the daemon opted in to 4:4:4", async () => {
    const browserEnv = (f: ReturnType<typeof fixture>) =>
      f.docker.requests
        .filter((request) => request.path === "/containers/create")
        .map((request) => request.body as { Hostname?: string; Env?: string[] })
        .find((spec) => spec.Hostname)?.Env;
    const standard = fixture();
    await standard.controller.start(standard.parent.id);
    expect(browserEnv(standard)).toContain("LOCALDOT_STREAM_FULLCOLOR=0");
    const opted = fixture();
    await new BrowserOrchestrator({ ...opted.deps, streamFullcolor: true }).start(opted.parent.id);
    expect(browserEnv(opted)).toContain("LOCALDOT_STREAM_FULLCOLOR=1");
  });

  it("gives the gate keyd's socket on Docker Engine", async () => {
    const f = fixture();
    const relay = { kind: "socket", keydDir: "/h/keyd/relay", toolDir: "/h/relay" } as const;
    await new BrowserOrchestrator({ ...f.deps, relay: async () => relay }).start(f.parent.id);
    const gate = f.docker.requests
      .filter((request) => request.path === "/containers/create")
      .map((request) => request.body as { Image?: string; Env?: string[]; HostConfig?: object })
      .find((spec) => spec.Image === "test/gate:dev");
    expect(gate?.Env).toContain("LD_KEYD_SOCKET=/run/localdot/keyd/4762.sock");
    expect(gate?.Env?.filter((entry) => entry.startsWith("LD_TOOL_SOCKET="))).toEqual([]);
    expect(gate?.HostConfig).toMatchObject({
      Mounts: [
        { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
      ],
    });
  });

  it("retains and wipes the private handoff buffer when Stop occurs during delivery", async () => {
    const f = fixture();
    const entered = deferred();
    let bytes: Buffer | undefined;
    f.deps.sendInput = async (_docker, _id, input, signal) => {
      bytes = input;
      entered.resolve();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    };
    const pending = f.controller.start(f.parent.id);
    const rejected = expect(pending).rejects.toThrow(BrowserStartCancelled);
    await entered.promise;
    await f.controller.stop(f.parent.id);
    await rejected;
    expect(bytes?.every((byte) => byte === 0)).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it("cannot republish after Stop interrupts a health reply", async () => {
    const f = fixture();
    const probe = f.deps.probe;
    if (!probe) throw new Error("missing fixture");
    const entered = deferred(),
      release = deferred();
    f.deps.probe = async (...args) => {
      const reply = await probe(...args);
      entered.resolve();
      await release.promise;
      return reply;
    };
    const pending = f.controller.start(f.parent.id);
    const rejected = expect(pending).rejects.toThrow(BrowserStartCancelled);
    await entered.promise;
    const stopped = f.controller.stop(f.parent.id);
    release.resolve();
    await Promise.all([rejected, stopped]);
    expect(f.controller.endpoints(f.parent.id)).toBeUndefined();
  });

  it("closes a listener after an open request succeeded but its reply was lost", async () => {
    const f = fixture();
    const open = f.keyd.openCell;
    f.keyd.openCell = async (request) => {
      await open(request);
      throw new Error("lost reply");
    };
    await expect(f.controller.start(f.parent.id)).rejects.toThrow("start failed");
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.size).toBe(0);
  });
});

it("does not re-reserve a desktop port after verified retirement, but keeps browser ownership", async () => {
  const f = fixture();
  const retired = new Set<string>();
  f.deps.retiredDesktopPortOwner = (id) => retired.has(id);
  expect(f.controller.reservedKeydPorts()).toContain(f.parent.keydPort);
  await f.controller.start(f.parent.id);
  const browser = f.store.browserFor(f.parent.id)!;
  retired.add(f.parent.id);
  expect(f.controller.reservedKeydPorts()).not.toContain(f.parent.keydPort);
  expect(f.controller.reservedKeydPorts()).toContain(browser.keydPort);
  expect(f.store.get(f.parent.id)).toBeDefined();
  retired.clear();
  expect(f.controller.reservedKeydPorts()).toContain(f.parent.keydPort);
});

describe("what the browser's status tells the app, the CLI and dot", () => {
  it("names what keeps it off and what clears it", async () => {
    const f = fixture();
    const block = {
      reason: "key-service-offline",
      problem: "localDot's key service isn't answering.",
      clears: "The key service running again.",
    } as const;
    const controller = new BrowserOrchestrator({ ...f.deps, unavailable: () => block });
    expect(await controller.status(f.parent.id)).toEqual({ state: "off", ...block });
  });

  it("keeps a browser usable while saved keys are locked, saying what they refuse", async () => {
    const f = fixture();
    let locked = true;
    const controller = new BrowserOrchestrator({ ...f.deps, keysLocked: () => locked });
    await controller.start(f.parent.id);
    expect(await controller.status(f.parent.id)).toMatchObject({
      state: "ready",
      reason: "keys-locked",
      problem: expect.stringContaining(
        "saved passwords and sites that use a saved key are refused",
      ),
      clears: "Unlock saved keys in localDot (Keys).",
    });
    locked = false;
    const unlocked = await controller.status(f.parent.id);
    expect(unlocked.state).toBe("ready");
    expect(unlocked.reason).toBeUndefined();
  });

  it("says when a start under way is done", async () => {
    const f = fixture();
    const entered = deferred(),
      resume = deferred();
    f.docker.before = async (request) => {
      if (request.path.endsWith("/start")) {
        entered.resolve();
        await resume.promise;
      }
    };
    const controller = new BrowserOrchestrator({ ...f.deps, readyTimeoutMs: 60_000 });
    const before = Date.now();
    const started = controller.start(f.parent.id);
    await entered.promise;
    const status = await controller.status(f.parent.id);
    expect(status).toMatchObject({ state: "starting", reason: "starting" });
    const readyBy = Date.parse(status.readyBy ?? "");
    expect(readyBy).toBeGreaterThanOrEqual(before + 60_000);
    expect(readyBy).toBeLessThanOrEqual(Date.now() + 60_000);
    resume.resolve();
    await started;
  });

  it("says when a failed start is tried again, and what to do once that is given up", async () => {
    const f = fixture();
    f.keyd.openCell = async () => {
      throw new Error("listener port in use");
    };
    await expect(f.controller.start(f.parent.id)).rejects.toThrow(
      "start failed during key listener creation",
    );
    f.controller.noteProblem(f.parent.id, "The web browser couldn't start: listener.");
    f.controller.noteRetry(f.parent.id, new Date("2026-10-29T08:00:05.000Z"));
    expect(await f.controller.status(f.parent.id)).toEqual({
      state: "failed",
      reason: "failed",
      problem: "The web browser couldn't start: listener.",
      problemAt: expect.any(String),
      retryAt: "2026-10-29T08:00:05.000Z",
      clears: "Nothing: localDot starts it again by itself.",
    });
    f.controller.noteRetry(f.parent.id, undefined);
    const given = await f.controller.status(f.parent.id);
    expect(given.retryAt).toBeUndefined();
    expect(given.clears).toMatch(/^Restart the web browser \(Settings → Accounts/u);
  });

  it("names a key service or Docker refusal without its paths or replies", async () => {
    const f = fixture();
    f.keyd.openCell = async () => {
      throw new KeydError(409, "conflict", "port 4762 is in use", "/v1/cells");
    };
    const error = await f.controller.start(f.parent.id).catch((failed: unknown) => failed);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Browser start failed during key listener creation (the key service refused it (409 conflict)); its profile has been retained",
    );
  });

  it("calls a start its computer gave up a cancellation, not a failure", async () => {
    const f = fixture();
    const entered = deferred(),
      resume = deferred();
    f.docker.before = async (request) => {
      if (request.path.endsWith("/start")) {
        entered.resolve();
        await resume.promise;
      }
    };
    const started = f.controller.start(f.parent.id);
    const cancelled = expect(started).rejects.toThrow(BrowserStartCancelled);
    await entered.promise;
    f.unavailable();
    resume.resolve();
    await cancelled;
    expect(f.controller.get(f.parent.id)?.state).toBe("stopped");
    expect(f.controller.problem(f.parent.id)).toBeUndefined();
    expect(f.listeners.size).toBe(0);
    expect(f.docker.containers.size).toBe(0);
  });

  it("tells the task once when a browser someone couldn't have runs again", async () => {
    const f = fixture();
    const notify = vi.fn();
    const controller = new BrowserOrchestrator({ ...f.deps, notify });
    await controller.start(f.parent.id);
    expect(notify).not.toHaveBeenCalled();
    await controller.stop(f.parent.id);
    const open = f.keyd.openCell;
    f.keyd.openCell = async () => {
      throw new Error("listener port in use");
    };
    await expect(controller.start(f.parent.id)).rejects.toThrow("start failed");
    f.keyd.openCell = open;
    f.nextInstance();
    await controller.start(f.parent.id);
    expect(notify.mock.calls).toEqual([[f.parent.id, BROWSER_BACK]]);
    await controller.stop(f.parent.id);
    f.nextInstance();
    await controller.start(f.parent.id);
    expect(notify).toHaveBeenCalledOnce();
    controller.noteOutage(f.parent.id);
    await controller.stop(f.parent.id);
    f.nextInstance();
    await controller.start(f.parent.id);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("tells the task its browser runs again after a recovery stopped it", async () => {
    const f = fixture();
    const notify = vi.fn();
    const controller = new BrowserOrchestrator({ ...f.deps, notify });
    await controller.start(f.parent.id);
    await controller.reconcile();
    f.nextInstance();
    await controller.start(f.parent.id);
    expect(notify.mock.calls).toEqual([[f.parent.id, BROWSER_BACK]]);
  });

  it("says which part of a stop could not be confirmed, up to a recovery", async () => {
    const f = fixture();
    await f.controller.start(f.parent.id);
    f.keyd.closeCell = async () => {
      throw new Error("key service offline");
    };
    await expect(f.controller.stop(f.parent.id)).rejects.toThrow(
      "Browser shutdown could not be confirmed (the key service did not confirm its connection closed); retry Stop",
    );
    await expect(f.controller.reconcile()).rejects.toThrow(
      "Browser recovery needs attention (Browser shutdown could not be confirmed (the key service did not confirm its connection closed); retry Stop)",
    );
  });
});
