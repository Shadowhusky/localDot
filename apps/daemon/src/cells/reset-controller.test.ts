import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerFences } from "../agent/safety/fences.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserLedgerStore } from "./browser-ledger.ts";
import { BrowserOrchestrator } from "./browser-orchestrator.ts";
import { browserNames } from "./browser-spec.ts";
import { DockerClient, DockerError } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { createComputerResetController } from "./reset-controller.ts";
import { ComputerResetHolds } from "./reset-holds.ts";
import { TicketRegistry } from "./secrets.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const old = "01JXYZ00000000000000000001",
  fresh = "01JXYZ00000000000000000002";
const browserId = "01JXYZ00000000000000000003",
  requestId = "01JXYZ00000000000000000004";
const confirmation = { requestId, eraseComputer: true as const };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-reset-controller-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const holds = new ComputerResetHolds(home),
    fences = new ComputerFences(home, (id) => holds.oldHeld(id));
  const store = new CellStore(home),
    oldRecord = sampleRecord(old);
  store.save(oldRecord);
  const ledgers = new BrowserLedgerStore(home, store.keydPorts);
  const browserOwner = "00000000-0000-4000-8000-000000000001";
  ledgers.save({
    v: 1,
    id: browserId,
    parentCellId: old,
    owner: browserOwner,
    prefix: "localdot-",
    createdAt: oldRecord.createdAt,
    scale: 2,
    keydPort: 4761,
    tokens: { browserd: "x".repeat(43), stream: "y".repeat(43) },
    resources: {},
    phase: "retained",
  });
  const profile = browserNames(browserId).profileVolume;
  const volumes = new Map<string, Record<string, string>>([
    [oldRecord.docker.homeVolume, { "localdot.cell": old, "localdot.role": "home" }],
    [
      profile,
      {
        "localdot.cell": browserId,
        "localdot.role": "profile",
        "localdot.parent": old,
        "localdot.browser-owner": browserOwner,
      },
    ],
  ]);
  const keys = new Map([
    [old, { cellId: old, role: "desktop", port: 4760 }],
    [browserId, { cellId: browserId, role: "browser", port: 4761 }],
  ]);
  const events: string[] = [];
  const cell = vi.fn(async (id: string) => keys.get(id));
  const closeCell = vi.fn(async (id: string) => {
    events.push(`close:${id}`);
    return keys.delete(id);
  });
  const keyd = {
    cell,
    closeCell,
    openCell: vi.fn(async () => {
      throw new Error("unexpected open");
    }),
  };
  const docker = new DockerClient(join(home, "unused.sock"));
  const copy = "c".repeat(64);
  const request = vi.spyOn(docker, "request").mockImplementation(async (input) => {
    if (input.path === "/containers/json") return [];
    if (input.path === "/volumes" && input.method === "GET")
      return {
        Volumes: [...volumes].map(([Name, Labels]) => ({ Name, Labels, CreatedAt: "" })),
      };
    if (input.path === "/volumes/create" && input.method === "POST") {
      const body = input.body as { Name: string; Labels: Record<string, string> };
      events.push(`make:${body.Name}`);
      volumes.set(body.Name, body.Labels);
      return { Name: body.Name };
    }
    if (input.path === "/containers/create") {
      const body = input.body as { HostConfig: { Mounts: { Source: string }[] } };
      events.push(`copy:${body.HostConfig.Mounts.map((mount) => mount.Source).join(">")}`);
      return { Id: copy };
    }
    if (input.path === `/containers/${copy}/wait`) return { StatusCode: 0 };
    if (input.path.startsWith(`/containers/${copy}`)) return undefined;
    const name = input.path.startsWith("/volumes/")
      ? decodeURIComponent(input.path.slice(9))
      : undefined;
    if (input.method === "GET" && name && volumes.has(name))
      return { Name: name, Labels: volumes.get(name) };
    if (input.method === "GET") throw new DockerError(404, "fixture absent", input.path);
    if (input.method !== "DELETE" || !name) throw new Error("unexpected fixture mutation");
    expect(keys.size).toBe(0);
    events.push(`erase:${name}`);
    volumes.delete(name);
    return undefined;
  });
  const cells = new CellOrchestrator({
    store,
    docker,
    images: { desktop: "fixture:dev", gate: "fixture:dev" },
    permanentFence: (id) => fences.isFenced(id),
    candidateHold: (id) => holds.candidateHeld(id),
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
    watchEveryMs: 0,
    keyd: {
      close: async (id) => {
        await closeCell(id);
      },
      wire: vi.fn(),
      isWired: async () => false,
      refresh: async () => [],
      revoke: async () => 0,
    },
  });
  cleanups.push(() => {
    cells.dispose();
    request.mockRestore();
  });
  const browser = new BrowserOrchestrator({
    home,
    store,
    docker,
    keyd,
    images: { browser: "fixture:dev", gate: "fixture:dev" },
    parentAvailable: (id) => !fences.isFenced(id),
  });
  let available = true,
    drained = true;
  const runner = {
    retireForReset: vi.fn(async () => {
      events.push("drain");
      return drained;
    }),
    resetTaskDrained: () => drained,
  };
  const create = vi.fn(async ({ id, scale }: { id?: string; scale: 1 | 2 }) => {
    if (!id) throw new Error("candidate missing");
    events.push("create");
    store.save({ ...sampleRecord(id), scale });
    const created = cells.get(id);
    if (!created) throw new Error("fixture creation failed");
    return { ...created, state: "ready" as const };
  });
  const controlledCells = {
    record: cells.record.bind(cells),
    hasStoredIdentity: cells.hasStoredIdentity.bind(cells),
    get: (id: string) => {
      const row = cells.get(id);
      return row && id === fresh ? { ...row, state: "ready" as const } : row;
    },
    create,
    retireReset: cells.retireReset.bind(cells),
    discardUpdate: cells.discardUpdate.bind(cells),
    inspectReplacement: vi.fn(async (id: string) =>
      store.get(id) ? ("ready" as const) : ("absent" as const),
    ),
    retireReplacement: cells.retireReplacement.bind(cells),
    holdReplacement: cells.holdReplacement.bind(cells),
    publishReplacement: cells.publishReplacement.bind(cells),
    thawReplacement: vi.fn(async (_id: string) => {}),
  };
  const deps = {
    home,
    holds,
    fences,
    docker,
    keyd,
    runner,
    cells: controlledCells,
    browser,
    available: () => available,
    allocateId: () => fresh,
  };
  const controller = createComputerResetController(deps);
  return {
    accounts: new AccountsProfile({ home, docker, prefix: "localdot-", image: () => "" }).volume,
    home,
    holds,
    fences,
    store,
    ledgers,
    volumes,
    keys,
    events,
    runner,
    cells,
    browser,
    create,
    closeCell,
    controller,
    deps,
    unavailable: () => {
      available = false;
    },
    uncertainDrain: () => {
      drained = false;
    },
  };
}
it("composes real computer/browser retirement, grant closure and durable publication; replay never erases again", async () => {
  const f = fixture();
  const done = await f.controller.reset(old, confirmation);
  expect(done.phase).toBe("ready");
  expect(f.store.get(old)).toBeUndefined();
  expect(f.ledgers.forParent(old)).toBeUndefined();
  expect([...f.volumes.keys()]).toEqual([f.accounts]);
  expect(f.keys.size).toBe(0);
  expect(f.events[0]).toBe("drain");
  expect(f.events.at(-1)).toBe("create");
  expect(f.store.get(fresh)).toBeDefined();
  expect(f.holds.candidateHeld(fresh)).toBe(false);
  expect(await f.controller.reset(old, confirmation)).toEqual(done);
  expect(f.create).toHaveBeenCalledOnce();
  const restartedHolds = new ComputerResetHolds(f.home);
  const restarted = createComputerResetController({ ...f.deps, holds: restartedHolds });
  expect(restartedHolds.candidateHeld(fresh)).toBe(false);
  vi.mocked(f.deps.cells.inspectReplacement).mockClear();
  await restarted.restoreReady();
  expect(f.deps.cells.inspectReplacement).not.toHaveBeenCalled();
  expect(restartedHolds.candidateHeld(fresh)).toBe(false);
  expect(f.cells.get(fresh)?.replacementPending).toBeUndefined();
  expect(f.create).toHaveBeenCalledOnce();
});
it.each([
  ["thaws a frozen candidate published before release receipts and confirms it", true],
  ["keeps a frozen unconfirmable candidate held", false],
])("on restart %s", async (_, recovers) => {
  const f = fixture();
  await f.controller.reset(old, confirmation);
  const receipt = join(f.home, "safety/computer-reset-releases", `${requestId}.json`);
  unlinkSync(receipt);
  let frozen = true;
  vi.mocked(f.deps.cells.inspectReplacement).mockImplementation(async () =>
    frozen ? "owned" : "ready",
  );
  vi.mocked(f.deps.cells.thawReplacement).mockImplementation(async () => {
    if (!recovers) throw new Error("not exactly owned");
    frozen = false;
  });
  const restartedHolds = new ComputerResetHolds(f.home);
  const restarted = createComputerResetController({
    ...f.deps,
    holds: restartedHolds,
    readyTimeoutMs: 1000,
  });
  expect(restartedHolds.candidateHeld(fresh)).toBe(true);
  if (recovers) await restarted.restoreReady();
  else await expect(restarted.restoreReady()).rejects.toThrow(`could not re-verify ${fresh}`);
  expect(f.deps.cells.thawReplacement).toHaveBeenCalledWith(fresh);
  expect(restartedHolds.candidateHeld(fresh)).toBe(!recovers);
  expect(existsSync(receipt)).toBe(recovers);
  expect(new ComputerResetHolds(f.home).candidateHeld(fresh)).toBe(!recovers);
  expect(f.create).toHaveBeenCalledOnce();
});
it("copies the computer's own sign-ins into the shared profile before erasing its old profile", async () => {
  const f = fixture();
  const profile = browserNames(browserId).profileVolume;
  await f.controller.reset(old, confirmation);
  const copied = f.events.indexOf(`copy:${profile}>${f.accounts}`);
  expect(f.events.indexOf(`make:${f.accounts}`)).toBeLessThan(copied);
  expect(copied).toBeGreaterThan(-1);
  expect(copied).toBeLessThan(f.events.indexOf(`erase:${profile}`));
  expect(f.volumes.get(f.accounts)?.["localdot.role"]).toBe("accounts-profile");
});
it("erases an old profile without copying once sign-ins already live in the shared profile", async () => {
  const f = fixture();
  writeFileSync(
    join(f.home, "accounts-profile.json"),
    JSON.stringify({ v: 1, owner: "00000000-0000-4000-8000-000000000009", migration: "done" }),
  );
  await f.controller.reset(old, confirmation);
  expect(f.events.some((event) => event.startsWith("copy:"))).toBe(false);
  expect(f.volumes.size).toBe(0);
});
it("leaves source records and volumes intact when task drain or key closure is unconfirmed", async () => {
  const f = fixture();
  f.uncertainDrain();
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.store.get(old)).toBeDefined();
  expect(f.volumes.size).toBe(2);
  expect(f.closeCell).not.toHaveBeenCalled();
  const g = fixture();
  g.closeCell.mockRejectedValue(new Error("fixture key failure"));
  await expect(g.controller.reset(old, confirmation)).rejects.toThrow();
  expect(g.store.get(old)).toBeDefined();
  expect(g.volumes.size).toBe(2);
  expect(g.create).not.toHaveBeenCalled();
});
it("refuses foreign ownership and candidate identities before task drain or volume mutation", async () => {
  const f = fixture();
  const record = f.store.get(old);
  if (!record) throw new Error("fixture source missing");
  f.volumes.set(record.docker.homeVolume, {
    "localdot.cell": fresh,
    "localdot.role": "home",
  });
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.runner.retireForReset).not.toHaveBeenCalled();
  expect(f.volumes.size).toBe(2);
  const g = fixture();
  g.store.save(sampleRecord(fresh));
  await expect(g.controller.reset(old, confirmation)).rejects.toThrow();
  expect(g.runner.retireForReset).not.toHaveBeenCalled();
  expect(g.create).not.toHaveBeenCalled();
});
it("preserves both volumes when the browser key listener fails to close", async () => {
  const f = fixture();
  f.closeCell.mockImplementation(async (id) => {
    if (id === browserId) throw new Error("fixture browser key closure uncertain");
    return f.keys.delete(id);
  });
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.keys.has(old)).toBe(false);
  expect(f.keys.has(browserId)).toBe(true);
  expect(f.volumes.size).toBe(2);
  expect(f.store.get(old)).toBeDefined();
  expect(f.create).not.toHaveBeenCalled();
});
it("retries the same transaction after physical cleanup succeeds but computer-record removal fails", async () => {
  const f = fixture(),
    remove = f.store.remove.bind(f.store);
  const spy = vi.spyOn(f.store, "remove").mockImplementation((id) => {
    if (id === old) throw new Error("fixture finalization unavailable");
    remove(id);
  });
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect([...f.volumes.keys()]).toEqual([f.accounts]);
  expect(f.store.get(old)).toBeDefined();
  expect(f.controller.status(old, requestId)?.phase).toBe("retiring");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.holds.candidateHeld(fresh)).toBe(true);
  spy.mockRestore();
  expect((await f.controller.reset(old, confirmation)).phase).toBe("ready");
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.store.get(old)).toBeUndefined();
});
it("refuses an unavailable daemon or invalid source without creating orphan holds", async () => {
  const f = fixture();
  f.unavailable();
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.holds.records()).toEqual([]);
  const g = fixture();
  g.store.remove(old);
  await expect(g.controller.reset(old, confirmation)).rejects.toThrow();
  expect(g.holds.records()).toEqual([]);
});
it("refuses while the computer is updating, before it captures anything", async () => {
  const f = fixture();
  const cells = {
    ...f.deps.cells,
    get: (id: string) => {
      const row = f.cells.get(id);
      return row && { ...row, updating: true as const };
    },
  };
  const controller = createComputerResetController({ ...f.deps, cells });
  await expect(controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.holds.records()).toEqual([]);
  expect(f.events).toEqual([]);
});
it("does not create a replacement if the daemon begins shutdown during old retirement", async () => {
  const f = fixture();
  f.runner.retireForReset.mockImplementation(async () => {
    f.unavailable();
    return true;
  });
  await expect(f.controller.reset(old, confirmation)).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.controller.status(old, requestId)?.phase).toBe("creating");
  expect(f.holds.candidateHeld(fresh)).toBe(true);
});
it("exposes authenticated, explicitly confirmed reset and status routes without a listening socket", async () => {
  const f = fixture(),
    log = new EventLog(f.home);
  cleanups.push(() => log.close());
  const token = "t".repeat(43),
    url = `http://127.0.0.1:4750/api/cells/${old}/reset`;
  const app = createApp({
    token,
    port: 4750,
    eventLog: log,
    cells: { cells: f.cells, tickets: new TicketRegistry(), reset: f.controller },
  });
  expect(
    (await app.request(url, { method: "POST", body: JSON.stringify(confirmation) })).status,
  ).toBe(401);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  expect(
    (await app.request(url, { method: "POST", headers, body: JSON.stringify({ requestId }) }))
      .status,
  ).toBe(400);
  expect(f.runner.retireForReset).not.toHaveBeenCalled();
  const response = await app.request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(confirmation),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ phase: "ready" });
  const status = await app.request(`${url}/${requestId}`, { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ newCellId: fresh });
});
