import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { SizeRefused } from "./computer-size.ts";
import { ComputerUpdateRefused } from "./computer-update.ts";
import { DockerError } from "./docker.ts";
import { SkippedCellsError } from "./orchestrator.ts";
import { TicketRegistry } from "./secrets.ts";
import { SYSTEM_BASE_MISSING, SystemBaseMissing } from "./system-migration-plan.ts";
import { SYSTEM_UPDATE_BLOCKED, SystemUpdateBlocked } from "./system-state.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const NOT_READY = ["starting", "stopping", "stopped", "failed"] as const;
const home = mkdtempSync(join(tmpdir(), "local dot's api-"));
const eventLog = new EventLog(home);
afterAll(() => {
  eventLog.close();
  rmSync(home, { recursive: true, force: true });
});

function setup() {
  const cells = new FakeOrchestrator();
  const tickets = new TicketRegistry();
  const app = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets } });
  return { app, cells, tickets };
}

async function readyCell(cells: FakeOrchestrator): Promise<CellSummary> {
  const ready: CellSummary = { ...(await cells.create({ scale: 2 })), state: "ready" };
  cells.emit(ready);
  return ready;
}

const mint = (app: Hono, id: string, headers: Record<string, string> = bearer) =>
  app.request(url(`/api/cells/${id}/stream-ticket`), { method: "POST", headers });

const minted = async (app: Hono, id: string) =>
  (await (await mint(app, id)).json()) as { ticket: string; path: string };

describe("cell API", () => {
  it("requires the install token", async () => {
    const { app } = setup();
    expect((await app.request(url("/api/cells"))).status).toBe(401);
    expect((await app.request(url("/api/cells"), { method: "POST" })).status).toBe(401);
  });

  it("lists, creates and reads cells", async () => {
    const { app } = setup();
    expect(await (await app.request(url("/api/cells"), { headers: bearer })).json()).toEqual([]);
    const created = await app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ scale: 1 }),
    });
    expect(created.status).toBe(202);
    const cell = (await created.json()) as CellSummary;
    expect(cell).toMatchObject({ state: "starting", scale: 1 });
    const read = await app.request(url(`/api/cells/${cell.id}`), { headers: bearer });
    expect(await read.json()).toEqual(cell);
    const empty = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(((await empty.json()) as CellSummary).scale).toBe(2);
  });

  it("rejects bad scales, bad ids and unknown cells", async () => {
    const { app } = setup();
    const bad = await app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ scale: 3 }),
    });
    expect(bad.status).toBe(400);
    expect((await app.request(url("/api/cells/../etc"), { headers: bearer })).status).toBe(404);
    expect((await app.request(url("/api/cells/not-a-ulid"), { headers: bearer })).status).toBe(400);
    expect(
      (await app.request(url("/api/cells/01JXYZ0000000000000000ABCD"), { headers: bearer })).status,
    ).toBe(404);
    expect(
      (
        await app.request(url("/api/cells/01JXYZ0000000000000000ABCD/stop"), {
          method: "POST",
          headers: bearer,
        })
      ).status,
    ).toBe(404);
  });

  it("issues stream tickets only for ready cells and revokes them on removal", async () => {
    const { app, cells, tickets } = setup();
    const cell = await cells.create({ scale: 2 });
    const early = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), {
      method: "POST",
      headers: bearer,
    });
    expect(early.status).toBe(409);
    cells.emit({ ...cell, state: "ready" });
    const res = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), {
      method: "POST",
      headers: bearer,
    });
    expect(res.status).toBe(200);
    const { ticket, path } = (await res.json()) as { ticket: string; path: string };
    expect(path).toBe(`/cells/${cell.id}/desktop/${ticket}/`);
    expect(tickets.resolve(ticket)).toBe(cell.id);
    const again = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), {
      method: "POST",
      headers: bearer,
    });
    expect(((await again.json()) as { ticket: string }).ticket).toBe(ticket);
    expect(
      (await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer }))
        .status,
    ).toBe(202);
    expect(tickets.resolve(ticket)).toBeUndefined();
    cells.emit({ ...cell, state: "ready" });
    const fresh = await app.request(url(`/api/cells/${cell.id}/stream-ticket`), {
      method: "POST",
      headers: bearer,
    });
    const reissued = ((await fresh.json()) as { ticket: string }).ticket;
    expect(reissued).not.toBe(ticket);
    expect(
      (await app.request(url(`/api/cells/${cell.id}`), { method: "DELETE", headers: bearer }))
        .status,
    ).toBe(204);
    expect(tickets.resolve(reissued)).toBeUndefined();
    expect(cells.get(cell.id)).toBeUndefined();
  });

  it("stops and starts a cell and maps Docker failures to 502", async () => {
    const { app, cells } = setup();
    const cell = await cells.create({ scale: 2 });
    expect(
      (await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer }))
        .status,
    ).toBe(202);
    expect(cells.get(cell.id)?.state).toBe("stopped");
    expect(
      (await app.request(url(`/api/cells/${cell.id}/start`), { method: "POST", headers: bearer }))
        .status,
    ).toBe(202);
    cells.failWith = new DockerError(
      0,
      "ECONNREFUSED; is Docker Desktop running?",
      "/networks/create",
    );
    const failed = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("Docker Desktop");
  });

  it("answers Update with the starting computer, a plain refusal, Docker's 502 or 503", async () => {
    const cells = new FakeOrchestrator();
    const tickets = new TicketRegistry();
    const cell = await readyCell(cells);
    const update = vi.fn(async (id: string, _signal: AbortSignal) => {
      cells.emit({ ...cell, id, state: "starting", updating: true });
    });
    const post = (app: Hono) =>
      app.request(url(`/api/cells/${cell.id}/update`), { method: "POST", headers: bearer });
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog,
      cells: { cells, tickets, update },
    });

    const started = await post(app);
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ id: cell.id, state: "starting", updating: true });
    expect(update).toHaveBeenCalledWith(cell.id, expect.any(AbortSignal));

    update.mockRejectedValueOnce(new ComputerUpdateRefused("Hand back the computer first."));
    const refused = await post(app);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toBe("Hand back the computer first.");

    update.mockRejectedValueOnce(new SystemBaseMissing(`sha256:${"a".repeat(64)}`));
    const missingBase = await post(app);
    expect(missingBase.status).toBe(409);
    expect(await missingBase.text()).toBe(SYSTEM_BASE_MISSING);

    update.mockRejectedValueOnce(new SystemUpdateBlocked());
    const preserved = await post(app);
    expect(preserved.status).toBe(409);
    expect(await preserved.text()).toBe(SYSTEM_UPDATE_BLOCKED);

    update.mockRejectedValueOnce(new DockerError(0, "ECONNREFUSED", "/containers/create"));
    expect((await post(app)).status).toBe(502);

    const without = createApp({ token: TOKEN, port: PORT, eventLog, cells: { cells, tickets } });
    const unavailable = await post(without);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("updates unavailable");
  });

  it("refuses a create body over 1 KiB with 413", async () => {
    const { app, cells } = setup();
    const res = await app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ scale: 2, pad: "x".repeat(2048) }),
    });
    expect(res.status).toBe(413);
    expect(cells.list()).toEqual([]);
  });

  it("revokes the cell's stream ticket even when its removal fails", async () => {
    const { app, cells, tickets } = setup();
    const cell = await readyCell(cells);
    const { ticket } = await minted(app, cell.id);
    vi.spyOn(cells, "remove").mockRejectedValueOnce(
      new DockerError(500, "removal failed", `/containers/localdot-gate-${cell.id}`),
    );
    const res = await app.request(url(`/api/cells/${cell.id}`), {
      method: "DELETE",
      headers: bearer,
    });
    expect(res.status).toBe(502);
    expect(tickets.resolve(ticket)).toBeUndefined();
  });

  it("refuses a new cell with 409 while a cell record can't be read", async () => {
    const { app, cells } = setup();
    cells.failWith = new SkippedCellsError(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    const res = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("mints stream tickets only through the authenticated API", async () => {
    const { app, cells, tickets } = setup();
    const cell = await readyCell(cells);
    const issue = vi.spyOn(tickets, "issue");
    const refusals: [Record<string, string>, number][] = [
      [{}, 401],
      [{ authorization: `Bearer ${"x".repeat(43)}` }, 401],
      [{ cookie: `localdot_session=${TOKEN}` }, 401],
      [{ "sec-websocket-protocol": `localdot.v1, localdot.token.${TOKEN}` }, 401],
      [{ ...bearer, origin: "http://evil.com" }, 403],
      [{ ...bearer, host: "evil.com" }, 403],
    ];
    for (const [headers, status] of refusals) {
      expect((await mint(app, cell.id, headers)).status).toBe(status);
    }
    const query = await app.request(url(`/api/cells/${cell.id}/stream-ticket?token=${TOKEN}`), {
      method: "POST",
    });
    expect(query.status).toBe(401);
    expect(
      (await app.request(url(`/api/cells/${cell.id}/stream-ticket`), { headers: bearer })).status,
    ).toBe(404);
    expect(issue).not.toHaveBeenCalled();
    expect((await mint(app, cell.id)).status).toBe(200);
    expect(issue).toHaveBeenCalledExactlyOnceWith(cell.id, undefined, undefined);
  });

  it("refuses a ticket while the cell is anything but ready", async () => {
    const { app, cells, tickets } = setup();
    const cell = await cells.create({ scale: 2 });
    const issue = vi.spyOn(tickets, "issue");
    for (const state of NOT_READY) {
      cells.emit({ ...cell, state });
      const res = await mint(app, cell.id);
      expect(res.status, state).toBe(409);
      expect(await res.text()).toBe(`cell is ${state}`);
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("revokes the ticket whenever the cell leaves ready, with no API call involved", async () => {
    const { app, cells, tickets } = setup();
    const cell = await readyCell(cells);
    for (const state of [...NOT_READY, "removed"] as const) {
      cells.emit(cell);
      const { ticket } = await minted(app, cell.id);
      cells.updateStream(cell.id, { connection: "live", viewers: 1 });
      expect(tickets.resolve(ticket), "a stream update keeps the cell ready").toBe(cell.id);
      cells.emit({ ...cell, state });
      expect(tickets.resolve(ticket), state).toBeUndefined();
    }
  });

  it("revokes the ticket on removal even when the orchestrator sends no event", async () => {
    const { app, cells, tickets } = setup();
    const cell = await readyCell(cells);
    const { ticket } = await minted(app, cell.id);
    vi.spyOn(cells, "remove").mockResolvedValue();
    expect(
      (await app.request(url(`/api/cells/${cell.id}`), { method: "DELETE", headers: bearer }))
        .status,
    ).toBe(204);
    expect(tickets.resolve(ticket)).toBeUndefined();
  });

  it("gives each cell its own ticket and path, and revokes per cell", async () => {
    const { app, cells, tickets } = setup();
    const a = await readyCell(cells);
    const b = await readyCell(cells);
    const forA = await minted(app, a.id);
    const forB = await minted(app, b.id);
    expect(forA.ticket).not.toBe(forB.ticket);
    expect(forA.path).toBe(`/cells/${a.id}/desktop/${forA.ticket}/`);
    expect(forB.path).toBe(`/cells/${b.id}/desktop/${forB.ticket}/`);
    expect(tickets.resolve(forA.ticket)).toBe(a.id);
    expect(tickets.resolve(forB.ticket)).toBe(b.id);
    cells.emit({ ...a, state: "stopping" });
    expect(tickets.resolve(forA.ticket)).toBeUndefined();
    expect(tickets.resolve(forB.ticket)).toBe(b.id);
  });

  it("purges the home volume only when asked with purge=1", async () => {
    const { app, cells } = setup();
    const cases = [
      ["", false],
      ["?purge=1", true],
      ["?purge=true", false],
      ["?purge=0", false],
    ] as const;
    for (const [query, purgeHome] of cases) {
      const cell = await cells.create({ scale: 2 });
      const res = await app.request(url(`/api/cells/${cell.id}${query}`), {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(204);
      expect(cells.removals.at(-1), query).toEqual({ id: cell.id, purgeHome });
    }
  });

  it("treats a JSON null body as no options", async () => {
    const { app } = setup();
    const res = await app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as CellSummary).scale).toBe(2);
  });

  it("writes nothing to the console while it mints, re-mints and revokes tickets", async () => {
    const methods = ["debug", "error", "info", "log", "trace", "warn"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const { app, cells } = setup();
      const cell = await readyCell(cells);
      expect((await mint(app, cell.id, {})).status).toBe(401);
      const { ticket } = await minted(app, cell.id);
      expect((await minted(app, cell.id)).ticket).toBe(ticket);
      expect(
        (await app.request(url(`/api/cells/${cell.id}/stop`), { method: "POST", headers: bearer }))
          .status,
      ).toBe(202);
      expect((await mint(app, cell.id)).status).toBe(409);
      expect(
        (
          await app.request(url(`/api/cells/${cell.id}?purge=1`), {
            method: "DELETE",
            headers: bearer,
          })
        ).status,
      ).toBe(204);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

it("revokes tickets while paused and issues a fresh ticket after resume", async () => {
  const { app, cells, tickets } = setup();
  const cell = await readyCell(cells);
  const { ticket } = (await (await mint(app, cell.id)).json()) as { ticket: string };
  cells.emit({ ...cell, paused: true });
  expect(tickets.resolve(ticket)).toBeUndefined();
  expect((await mint(app, cell.id)).status).toBe(409);
  cells.emit(cell);
  const resumed = (await (await mint(app, cell.id)).json()) as { ticket: string };
  expect(resumed.ticket).not.toBe(ticket);
});

it("reports runtime availability without exposing diagnostic secrets or allowing creation while down", async () => {
  const cells = new FakeOrchestrator(),
    tickets = new TicketRegistry();
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    cells: {
      cells,
      tickets,
      runtimeStatus: async () => ({ docker: "unavailable", startup: "waiting" }),
      checkRuntime: async () => {
        throw new DockerError(0, "not available", "/info");
      },
    },
  });
  expect((await app.request(url("/api/runtime"))).status).toBe(401);
  expect(await (await app.request(url("/api/runtime"), { headers: bearer })).json()).toEqual({
    docker: "unavailable",
    startup: "waiting",
  });
  const response = await app.request(url("/api/cells"), { method: "POST", headers: bearer });
  expect(response.status).toBe(502);
  expect(cells.list()).toHaveLength(0);
});

describe("several dots' computers on one Docker", () => {
  const create = (app: Hono) =>
    app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ scale: 2 }),
    });

  it("warns, in plain words, before one more computer than Docker's memory holds, and starts it anyway when asked", async () => {
    const cells = new FakeOrchestrator();
    const advice =
      "Two running computers need about 10 GB for Docker; it has 8 GB. Raise it in Docker Desktop → Settings → Resources.";
    const capacity = vi.fn(async (starting?: string) => (starting === "ok" ? undefined : advice));
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog,
      cells: { cells, tickets: new TicketRegistry(), capacity },
    });
    const refused = await create(app);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toBe(advice);
    expect(cells.list()).toEqual([]);
    const cell = await cells.create({ scale: 2 });
    const start = await app.request(url(`/api/cells/${cell.id}/start`), {
      method: "POST",
      headers: bearer,
    });
    expect(start.status).toBe(409);
    expect(capacity).toHaveBeenLastCalledWith(cell.id);
    const anyway = await app.request(url(`/api/cells/${cell.id}/start`), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(anyway.status).toBe(202);
    const made = await app.request(url("/api/cells"), {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ scale: 2, force: true }),
    });
    expect(made.status).toBe(202);
    expect(capacity).toHaveBeenCalledTimes(2);
  });

  it("makes the first computer from one copied from another dot, once", async () => {
    const cells = new FakeOrchestrator();
    const created = vi.spyOn(cells, "create");
    const snapshot = "01JXYZ00000000000000000042";
    let waiting: string | undefined = snapshot;
    const done = vi.fn(async () => {});
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog,
      cells: {
        cells,
        tickets: new TicketRegistry(),
        importComputer: {
          take: () => {
            const taken = waiting;
            waiting = undefined;
            return taken;
          },
          done,
        },
      },
    });
    expect((await create(app)).status).toBe(202);
    expect(created).toHaveBeenLastCalledWith({ scale: 2, restoreFrom: snapshot });
    expect(done).toHaveBeenCalledWith(snapshot);
    expect((await create(app)).status).toBe(202);
    expect(created).toHaveBeenLastCalledWith({ scale: 2 });
  });

  it("explains Docker running out of network addresses", async () => {
    const cells = new FakeOrchestrator();
    vi.spyOn(cells, "create").mockRejectedValue(
      new DockerError(
        400,
        "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network",
        "/networks/create",
      ),
    );
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog,
      cells: { cells, tickets: new TicketRegistry() },
    });
    const refused = await create(app);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("no network addresses left");
  });
});

describe("the computer's size", () => {
  const GIB = 1024 ** 3;
  function sized() {
    const view = { size: { memoryBytes: 4 * GIB, cpus: 4 } };
    const size = {
      view: vi.fn(async () => view as never),
      change: vi.fn(async (next: { memoryBytes: number; cpus: number }) => {
        if (next.memoryBytes > 6 * GIB)
          throw new SizeRefused(409, "Docker can hold at most 6 GB for this computer now.");
        return { size: next } as never;
      }),
    };
    const app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog,
      cells: { cells: new FakeOrchestrator(), tickets: new TicketRegistry(), size },
    });
    const put = (body: unknown) =>
      app.request(url("/api/computer-size"), {
        method: "PUT",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { app, size, put };
  }

  it("reads it with the install token only, never cached", async () => {
    const { app } = sized();
    expect((await app.request(url("/api/computer-size"))).status).toBe(401);
    const read = await app.request(url("/api/computer-size"), { headers: bearer });
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ size: { memoryBytes: 4 * GIB, cpus: 4 } });
  });

  it("changes it, and answers a refusal in plain words", async () => {
    const { size, put } = sized();
    expect(await (await put({ memoryBytes: 6 * GIB, cpus: 8 })).json()).toEqual({
      size: { memoryBytes: 6 * GIB, cpus: 8 },
    });
    const refused = await put({ memoryBytes: 8 * GIB, cpus: 8 });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toBe("Docker can hold at most 6 GB for this computer now.");
    for (const bad of [{ memoryBytes: 4 * GIB }, { memoryBytes: 4 * GIB, cpus: 2.5 }, null])
      expect((await put(bad)).status).toBe(400);
    expect(size.change).toHaveBeenCalledTimes(2);
  });

  it("says Docker isn't answering when it can't be reached", async () => {
    const { app, size } = sized();
    size.view.mockRejectedValueOnce(new DockerError(0, "ENOENT", "/info"));
    const read = await app.request(url("/api/computer-size"), { headers: bearer });
    expect(read.status).toBe(503);
    expect(await read.text()).toBe(
      "Docker isn't answering, so the computer's size can't be changed now.",
    );
  });
});
