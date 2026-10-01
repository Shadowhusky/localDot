import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { DockerError } from "./docker.ts";
import { SkippedCellsError } from "./orchestrator.ts";
import { TicketRegistry } from "./secrets.ts";
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
    expect(issue).toHaveBeenCalledExactlyOnceWith(cell.id);
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
