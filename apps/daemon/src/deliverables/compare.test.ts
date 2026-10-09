import { CompareReply } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cleanFixtures, deliverablesFixture } from "./testing/fixture.ts";

afterEach(cleanFixtures);
const compare = async (
  f: ReturnType<typeof deliverablesFixture>,
  id: string,
  name: string,
  query: string,
) => f.get(`/api/agent/sessions/${id}/files/${name}/compare?${query}`);
describe("compare", () => {
  it("shows a csv diff between v1 and v2, ignoring line endings", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "totals.csv": "Month,Net\r\nDec,12000\r\n" });
    f.result(id, { "totals.csv": "Month,Net\nDec,12311\n" });
    const reply = CompareReply.parse(
      await (await compare(f, id, "totals.csv", `from=${id}.1&to=${id}.2`)).json(),
    );
    expect([reply.from, reply.to, reply.truncated]).toEqual([1, 2, false]);
    expect(reply.patch).toContain("-Dec,12000\n+Dec,12311");
    expect(reply.patch).not.toContain("-Month,Net");
  });
  it("returns an empty patch for identical versions", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "a.md": "same\n" });
    f.result(id, { "a.md": "same\n" });
    const reply = CompareReply.parse(
      await (await compare(f, id, "a.md", `from=${id}.1&to=${id}.2`)).json(),
    );
    expect(reply.patch).toBe("");
  });
  it("refuses versions outside the file's lineage, binary kinds and bad references", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    const other = f.task();
    f.result(id, { "a.csv": "1\n" });
    f.result(other, { "a.csv": "2\n" });
    expect((await compare(f, id, "a.csv", `from=${id}.1&to=${other}.1`)).status).toBe(404);
    expect((await compare(f, id, "a.png", `from=${id}.1&to=${id}.1`)).status).toBe(400);
    expect((await compare(f, id, "a.csv", `from=${id}&to=${id}.1`)).status).toBe(400);
  });
  it("refuses text over 1 MiB or with NUL bytes", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "a.txt": "x".repeat(1024 * 1024 + 1) });
    f.result(id, { "a.txt": "a\u0000b" });
    expect((await compare(f, id, "a.txt", `from=${id}.1&to=${id}.2`)).status).toBe(422);
  });
});
