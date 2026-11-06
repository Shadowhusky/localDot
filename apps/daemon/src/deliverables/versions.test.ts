import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationFilesReply, FileVersionsReply, ulid } from "@localdot/protocol";
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

describe("the files of a conversation", () => {
  const listed = async (f: ReturnType<typeof deliverablesFixture>, id: string) =>
    ConversationFilesReply.parse(
      await (await f.get(`/api/agent/sessions/${id}/conversation-files`)).json(),
    );

  it("lists every task's files, newest first, each still downloadable", async () => {
    const f = deliverablesFixture({
      conversation: (id) => ({ sessions: chain.slice(0, chain.indexOf(id) + 1), more: false }),
    });
    const first = f.task();
    const second = f.task();
    const chain = [first, second];
    f.result(first, { "plan.txt": "one", "shared.txt": "from the first run" });
    f.result(second, { "shared.txt": "from the second run", "report.pdf": "%PDF-" });
    const { files, more } = await listed(f, second);
    expect(more).toBe(false);
    expect(files.map((file) => [file.sessionId, file.name, file.available])).toEqual([
      [second, "report.pdf", true],
      [second, "shared.txt", true],
      [first, "shared.txt", true],
      [first, "plan.txt", true],
    ]);
    // Asked of the first run's own task, the second run's file isn't its concern.
    expect((await listed(f, first)).files.map((file) => file.name)).toEqual([
      "shared.txt",
      "plan.txt",
    ]);
    const older = files.find((file) => file.sessionId === first && file.name === "shared.txt");
    const body = await f.get(
      `/api/agent/sessions/${first}/files/shared.txt/versions/${older?.version}`,
    );
    expect(await body.text()).toBe("from the first run");
  });

  it("shows a file handed over twice in a task once, as its latest", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "totals.csv": "1" });
    f.result(id, { "totals.csv": "22" });
    const { files } = await listed(f, id);
    expect(files.map((file) => [file.name, file.version, file.bytes])).toEqual([
      ["totals.csv", 2, 2],
    ]);
  });

  it("lets a revising task take over the row of the file it revises", async () => {
    const f = deliverablesFixture({
      conversation: () => ({ sessions: [parent, child], more: false }),
    });
    const parent = f.task();
    f.result(parent, { "totals.csv": "a\n1\n", "notes.txt": "kept" });
    const child = f.log.createSession("Revise totals.csv: add a total row");
    f.log.append(child, start({ sessionId: parent, name: "totals.csv", version: 1 }));
    f.result(child, { "totals.csv": "a\n2\n" });
    const { files } = await listed(f, child);
    expect(files.map((file) => [file.sessionId, file.name])).toEqual([
      [child, "totals.csv"],
      [parent, "notes.txt"],
    ]);
  });

  it("keeps a deleted file listed, saying its bytes are gone", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "gone.txt": "bye", "here.txt": "hi" });
    rmSync(join(f.home, "sessions", id, "versions", "gone.txt"), { recursive: true });
    rmSync(join(f.home, "sessions", id, "out", "gone.txt"));
    const { files } = await listed(f, id);
    expect(files.find((file) => file.name === "gone.txt")?.available).toBe(false);
    expect(files.find((file) => file.name === "here.txt")?.available).toBe(true);
    expect((await f.get(`/api/agent/sessions/${id}/files/gone.txt`)).status).toBe(404);
  });

  it("refuses a task it doesn't know, and says when older tasks are left out", async () => {
    const f = deliverablesFixture({ conversation: (id) => ({ sessions: [id], more: true }) });
    expect((await f.get(`/api/agent/sessions/${ulid()}/conversation-files`)).status).toBe(404);
    expect((await listed(f, f.task())).more).toBe(true);
  });
});
