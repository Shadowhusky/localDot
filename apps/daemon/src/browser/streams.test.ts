import { randomUUID } from "node:crypto";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { TicketRegistry } from "../cells/secrets.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { BrowserStreams } from "./streams.ts";

function fixture() {
  const parent: CellSummary = {
    id: ulid(),
    state: "ready",
    scale: 2,
    createdAt: "2026-10-06T00:00:00Z",
    stream: { ...NO_STREAM },
  };
  let ready: ReadyBrowser | undefined = {
    parentCellId: parent.id,
    browserCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl: "http://127.0.0.1:7001", token: "private-test-token" },
    stream: { baseUrl: "http://127.0.0.1:7002", authorization: "private-test-credential" },
  };
  const parentListeners = new Set<(cell: CellSummary) => void>();
  const browserListeners = new Set<(id: string) => void>();
  const tickets = new TicketRegistry();
  const streams = new BrowserStreams({
    parents: {
      get: (id) => (id === parent.id ? structuredClone(parent) : undefined),
      list: () => [parent],
      subscribe: (listener) => {
        parentListeners.add(listener);
        return () => {
          parentListeners.delete(listener);
        };
      },
    },
    browser: {
      endpoints: (id) => (id === parent.id && ready ? structuredClone(ready) : undefined),
      subscribe: (listener) => {
        browserListeners.add(listener);
        return () => {
          browserListeners.delete(listener);
        };
      },
    },
    tickets,
  });
  const changed = () => {
    for (const listener of browserListeners) listener(parent.id);
  };
  return {
    parent,
    streams,
    tickets,
    parentListeners,
    browserListeners,
    changed,
    current: () => ready,
    set: (value: ReadyBrowser | undefined) => {
      ready = value;
    },
  };
}

describe("physical browser viewer state", () => {
  it("tracks browser health without changing desktop health or exposing endpoint credentials", () => {
    const f = fixture();
    const cell = f.streams.forParent(f.parent.id);
    expect(cell).toBeDefined();
    const listener = vi.fn();
    f.streams.subscribe(listener);
    f.streams.updateStream(cell!.id, { connection: "stalled", viewers: 1, lastUpstreamAt: 22 });
    expect(f.streams.get(cell!.id)?.stream.connection).toBe("stalled");
    expect(f.parent.stream).toEqual(NO_STREAM);
    expect(JSON.stringify(listener.mock.calls)).not.toMatch(/private-test|authorization|browserd/);
    expect(f.streams.endpoints(f.parent.id)).toBeUndefined();
    f.streams.dispose();
  });

  it("revokes and drops the old instance before publishing a restart with the same cell ID", () => {
    const f = fixture(),
      old = f.current()!;
    const ticket = f.tickets.issue(old.browserCellId),
      events: CellSummary[] = [];
    const atDrop: { ticket: string | undefined; visible: CellSummary | undefined }[] = [];
    f.streams.subscribe((cell) => {
      events.push(cell);
      if (cell.state === "stopped") {
        atDrop.push({ ticket: f.tickets.resolve(ticket), visible: f.streams.get(cell.id) });
        f.streams.updateStream(cell.id, { connection: "live", viewers: 100, lastUpstreamAt: 99 });
      }
    });
    f.set({ ...old, instance: randomUUID() });
    f.changed();
    expect(events.map((cell) => cell.state)).toEqual(["stopped", "ready"]);
    expect(atDrop).toEqual([{ ticket: undefined, visible: undefined }]);
    expect(f.streams.get(old.browserCellId)?.stream).toEqual(NO_STREAM);
    expect(f.tickets.issue(old.browserCellId)).not.toBe(ticket);
    f.streams.dispose();
  });

  it.each(["paused", "fenced", "replacementPending"] as const)(
    "drops browser access when its parent becomes %s",
    (kind) => {
      const f = fixture(),
        id = f.current()!.browserCellId;
      const ticket = f.tickets.issue(id),
        listener = vi.fn();
      f.streams.subscribe(listener);
      if (kind === "fenced") f.parent.fenced = { revision: 1 };
      else f.parent[kind] = true;
      for (const notify of f.parentListeners) notify(f.parent);
      expect(f.streams.get(id)).toBeUndefined();
      expect(f.streams.endpoints(id)).toBeUndefined();
      expect(f.tickets.resolve(ticket)).toBeUndefined();
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id, state: "stopped" }));
      f.streams.dispose();
    },
  );

  it("checks authority even without an event and unsubscribes on disposal", () => {
    const f = fixture(),
      id = f.current()!.browserCellId;
    f.set(undefined);
    expect(f.streams.get(id)).toBeUndefined();
    expect(f.streams.endpoints(id)).toBeUndefined();
    f.streams.dispose();
    expect(f.parentListeners.size).toBe(0);
    expect(f.browserListeners.size).toBe(0);
  });
});
