// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../lib/api.ts";
import {
  deleteEntry,
  deletePerson,
  editEntry,
  loadEntries,
  MemoryRequestError,
} from "./memory-api.ts";

const entry = {
  id: "01JXYZ0000000000000000AAAA",
  file: "USER.md" as const,
  text: "Lives in Lisbon",
  source: { kind: "user" as const },
  at: "2026-10-08",
  pinned: false,
  revision: "0123456789abcdef",
};
const note = {
  ...entry,
  id: "01JXYZ0000000000000000NNNN",
  file: "notes/2026-10-08.md" as const,
  source: { kind: "task" as const, sessionId: "01JXYZ0000000000000000TASK", title: "Insurance" },
};
const person = {
  id: "01JXYZ0000000000000000PPPP",
  name: "Henry",
  app: "WeChat",
  handle: "henry_l",
  note: null,
  lastAt: "2026-10-08",
  source: { kind: "user" as const },
  revision: "fedcba9876543210",
};
function api(respond: (url: string, init: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  return {
    client: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1:4768" }),
    fetchImpl,
  };
}

describe("memory api", () => {
  it("parses the entries reply", async () => {
    const { client } = api(() =>
      Response.json({
        dir: "~/.localdot/memory",
        files: [
          { file: "USER.md", entries: [entry] },
          { file: "MEMORY.md", entries: [] },
        ],
        notes: [{ file: "notes/2026-10-08.md", entries: [note] }],
      }),
    );
    const reply = await loadEntries(client, new AbortController().signal);
    expect(reply.files[0]?.entries[0]?.text).toBe("Lives in Lisbon");
    expect(reply.notes[0]?.entries[0]?.file).toBe("notes/2026-10-08.md");
  });
  it("sends the revision and maps 409 to stale", async () => {
    const { client, fetchImpl } = api(() => new Response("changed", { status: 409 }));
    await expect(editEntry(client, entry, { pinned: true })).rejects.toMatchObject({
      reason: "stale",
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4768/api/agent/memory/entries/${entry.id}`);
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"a".repeat(43)}`);
    expect(JSON.parse(String(init.body))).toEqual({
      file: "USER.md",
      revision: entry.revision,
      pinned: true,
    });
  });
  it("deletes with the file and revision in the query and returns the change id", async () => {
    const { client, fetchImpl } = api((url) =>
      Response.json(url.includes("/people/") ? {} : { changeId: "01JXYZ0000000000000000CHNG" }),
    );
    expect((await deleteEntry(client, entry)).changeId).toBe("01JXYZ0000000000000000CHNG");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      `/api/agent/memory/entries/${entry.id}?file=USER.md&revision=${entry.revision}`,
    );
    await deleteEntry(client, note);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      `/api/agent/memory/entries/${note.id}?file=notes%2F2026-10-08.md&revision=`,
    );
    await deletePerson(client, person);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
      `/api/agent/people/${person.id}?revision=${person.revision}`,
    );
  });
  it("tells a full or unreadable file apart from a change made meanwhile", async () => {
    const add = (status: number) =>
      deletePerson(api(() => new Response("", { status })).client, person);
    await expect(add(413)).rejects.toMatchObject({ reason: "full" });
    await expect(add(500)).rejects.toMatchObject({ reason: "unreadable" });
    await expect(add(409)).rejects.toMatchObject({ reason: "stale" });
  });
  it("maps 503 to busy, 404 to missing and a network failure to offline", async () => {
    const busy = deleteEntry(api(() => new Response("", { status: 503 })).client, entry);
    await expect(busy).rejects.toBeInstanceOf(MemoryRequestError);
    await expect(
      deleteEntry(api(() => new Response("", { status: 503 })).client, entry),
    ).rejects.toMatchObject({ reason: "busy" });
    await expect(
      deleteEntry(api(() => new Response("", { status: 404 })).client, entry),
    ).rejects.toMatchObject({ reason: "missing" });
    await expect(
      deleteEntry(
        api(() => {
          throw new TypeError("network");
        }).client,
        entry,
      ),
    ).rejects.toMatchObject({ reason: "offline" });
  });
});
