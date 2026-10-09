import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileVersionsReply, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cleanFixtures, deliverablesFixture } from "./testing/fixture.ts";

afterEach(cleanFixtures);
const versions = async (f: ReturnType<typeof deliverablesFixture>, id: string, name: string) =>
  FileVersionsReply.parse(
    await (await f.get(`/api/agent/sessions/${id}/files/${name}/versions`)).json(),
  ).versions;
const start = (revises: { sessionId: string; name: string; version: number }) =>
  ({
    type: "session.start",
    agent: "main",
    data: { screen: { w: 1, h: 1, scale: 1 }, os: "linux", revises },
  }) as const;

describe("file versions", () => {
  it("lists v1 and v2 of a file returned twice in one task, and serves each", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "totals.csv": "Month,Net\nDec,12000\n" });
    f.result(id, { "totals.csv": "Month,Net\nDec,12311\n" });
    expect(
      (await versions(f, id, "totals.csv")).map((v) => [v.label, v.version, v.available]),
    ).toEqual([
      [1, 1, true],
      [2, 2, true],
    ]);
    const v1 = await f.get(`/api/agent/sessions/${id}/files/totals.csv/versions/1`);
    expect(await v1.text()).toContain("12000");
    expect(v1.headers.get("content-disposition")).toContain("totals.csv");
    expect((await f.get(`/api/agent/sessions/${id}/files/totals.csv/versions/3`)).status).toBe(404);
  });
  it("follows a revising task back to the version it revised", async () => {
    const f = deliverablesFixture();
    const parent = f.task();
    f.result(parent, { "totals.csv": "a\n1\n" });
    const child = f.log.createSession("Revise totals.csv: add a total row");
    f.log.append(child, start({ sessionId: parent, name: "totals.csv", version: 1 }));
    f.result(child, { "totals.csv": "a\n1\nTotal,1\n" });
    expect((await versions(f, child, "totals.csv")).map((v) => [v.sessionId, v.label])).toEqual([
      [parent, 1],
      [child, 2],
    ]);
    // A link for another file name is not followed.
    expect((await versions(f, child, "chart.png")).length).toBe(0);
  });
  it("stops at a revise loop", async () => {
    const f = deliverablesFixture();
    const a = f.log.createSession("A");
    const b = f.log.createSession("B");
    f.log.append(a, start({ sessionId: b, name: "x.txt", version: 1 }));
    f.log.append(b, start({ sessionId: a, name: "x.txt", version: 1 }));
    f.result(a, { "x.txt": "a" });
    f.result(b, { "x.txt": "b" });
    expect((await versions(f, a, "x.txt")).length).toBe(2);
  });
  it("marks an overwritten result from before versions existed as unavailable", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    mkdirSync(join(f.home, "sessions", id, "out"), { recursive: true });
    writeFileSync(join(f.home, "sessions", id, "out", "a.txt"), "second");
    for (const _ of [1, 2])
      f.log.append(id, {
        type: "task.result",
        agent: "main",
        data: { summary: "s", files: [{ name: "a.txt", path: "a.txt", bytes: 6 }] },
      });
    expect((await versions(f, id, "a.txt")).map((v) => [v.version, v.available])).toEqual([
      [null, false],
      [null, true],
    ]);
  });
  it("refuses traversal, encoded separators and dot names, and unknown tasks", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    for (const name of ["..%2Fsecret", "a%2Fb.csv", ".hidden", "%00.csv"])
      expect((await f.get(`/api/agent/sessions/${id}/files/${name}/versions`)).status, name).toBe(
        400,
      );
    // The URL parser folds %2E%2E into "..", so that path is simply not found.
    expect((await f.get(`/api/agent/sessions/${id}/files/%2E%2E/versions`)).status).toBe(404);
    expect((await f.get(`/api/agent/sessions/${ulid()}/files/a.csv/versions`)).status).toBe(404);
  });
});
