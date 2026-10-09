import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../agent/runner.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { ReviseDeps } from "./routes.ts";
import { cleanFixtures, deliverablesFixture } from "./testing/fixture.ts";

const CELL = "01JXYZ0000000000000000CE11";
afterEach(cleanFixtures);
function fixture(over: Partial<ReviseDeps> = {}) {
  const put = vi.fn(async (path: string, source: ReadableStream<Uint8Array>) => {
    await new Response(source).arrayBuffer();
    return `~/${path}`;
  });
  const released = vi.fn();
  const start = vi.fn<ReviseDeps["start"]>(async () => ({ id: ulid() }));
  const f = deliverablesFixture({
    revise: {
      start,
      access: () => ({
        tools: { putFile: put },
        signal: new AbortController().signal,
        check: () => {},
        release: released,
      }),
      redactUserText: (text) => text.replace("sk-proj-SECRET", "[key]"),
      ...over,
    },
  });
  const id = f.task();
  f.result(id, { "totals.csv": "a\n1\n" });
  const post = (body: unknown, name = "totals.csv") =>
    f.app.request(`http://127.0.0.1:4747/api/agent/sessions/${id}/files/${name}/revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { id, post, put, start, released };
}

describe("revise an ended task's file", () => {
  it("copies the chosen version into the computer and starts a task linked to it", async () => {
    const f = fixture();
    const res = await f.post({
      cellId: CELL,
      version: 1,
      text: "Revise totals.csv: add a total row",
    });
    expect(res.status).toBe(202);
    expect(Object.keys((await res.json()) as object)).toEqual(["sessionId"]);
    const folder = `Downloads/revise-${f.id.slice(-6).toLowerCase()}-v1`;
    expect(f.put.mock.calls[0]?.[0]).toBe(`${folder}/totals.csv`);
    const [cell, task, , opts] = f.start.mock.calls[0] ?? [];
    expect(cell).toBe(CELL);
    expect(task).toMatch(
      /^Revise totals\.csv: add a total row\n\n\(totals\.csv v1 is on this computer at ~\/Downloads\/revise-/,
    );
    expect(opts).toEqual({ revises: { sessionId: f.id, name: "totals.csv", version: 1 } });
    expect(f.released).toHaveBeenCalledOnce();
  });
  it("redacts the user's words before the task starts", async () => {
    const f = fixture();
    await f.post({ cellId: CELL, version: 1, text: "Revise totals.csv: use sk-proj-SECRET" });
    expect(f.start.mock.calls[0]?.[1]).not.toContain("sk-proj-SECRET");
  });
  it("refuses a pasted key before copying or starting anything, like a new task does", async () => {
    const f = fixture();
    const res = await f.post({
      cellId: CELL,
      version: 1,
      text: `Revise totals.csv: use ${`sk-proj-${"A".repeat(40)}`}`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Recognised API keys belong in Keys, not task text.");
    expect(f.put).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("answers 409, not 500, when the computer refuses the copy", async () => {
    const f = fixture({
      access: () => {
        throw new AgentError(
          409,
          "the task is changing control; retry the upload when it is ready",
        );
      },
    });
    expect((await f.post({ cellId: CELL, version: 1, text: "Revise totals.csv: x" })).status).toBe(
      409,
    );
    expect(f.start).not.toHaveBeenCalled();
  });
  it("reuses a copy already in the computer", async () => {
    const f = fixture();
    f.put.mockRejectedValueOnce(new DesktopdError(409, "exists", "/files/put"));
    expect(
      (await f.post({ cellId: CELL, version: 1, text: "Revise totals.csv: again" })).status,
    ).toBe(202);
  });
  it("refuses a missing version, a busy computer and bad bodies without starting anything", async () => {
    const f = fixture();
    expect((await f.post({ cellId: CELL, version: 2, text: "x" })).status).toBe(404);
    expect((await f.post({ cellId: "nope", version: 1, text: "x" })).status).toBe(400);
    expect((await f.post({ cellId: CELL, version: 1, text: "   " })).status).toBe(400);
    f.start.mockRejectedValueOnce(new AgentError(409, "busy"));
    expect((await f.post({ cellId: CELL, version: 1, text: "Revise totals.csv: x" })).status).toBe(
      409,
    );
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
