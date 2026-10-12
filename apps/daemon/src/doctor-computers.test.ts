import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { DockerClient } from "./cells/docker.ts";
import { sampleRecord } from "./cells/testing/sample-record.ts";
import { computerContainerCheck } from "./doctor-computers.ts";

const home = "/private/localdot-test";
const record = sampleRecord("01JXYZ00000000000000000001");
function row(role: string, state: string, id = (role === "gate" ? "a" : "b").repeat(64)) {
  return { Id: id, State: state, Labels: { "localdot.cell": record.id, "localdot.role": role } };
}
async function check(rows: unknown, invalid = false) {
  const request = vi.fn(async () => rows);
  const result = await computerContainerCheck(
    { request } as unknown as DockerClient,
    home,
    async () => ({ records: [{ ...record, ownership: undefined }], invalid, digest: "test" }),
  );
  expect(request.mock.calls.length).toBeLessThanOrEqual(1);
  if (request.mock.calls.length)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", query: expect.objectContaining({ all: "true" }) }),
    );
  return result;
}
it("reports stopped containers as stopped without clearing native retirement", async () => {
  expect(await check([row("gate", "exited"), row("desktop", "exited")])).toMatchObject({
    ok: true,
    detail: expect.stringContaining("2 stopped"),
  });
});
it("separates running and paused states", async () => {
  expect((await check([row("gate", "running"), row("desktop", "paused")])).detail).toContain(
    "1 running, 1 paused",
  );
});
it("reports missing containers without implying their saved data was deleted", async () => {
  expect((await check([])).detail).toContain("2 saved computer containers are absent");
});
it("reports a partially missing computer and restarting or dead containers for repair", async () => {
  for (const rows of [
    [row("gate", "running")],
    [row("gate", "running"), row("desktop", "exited")],
    [row("gate", "running"), row("desktop", "restarting")],
    [row("gate", "exited"), row("desktop", "dead")],
  ]) {
    expect(await check(rows)).toMatchObject({
      ok: false,
      pendingAction: "recover-computer",
      detail: expect.stringContaining("doctor --fix"),
    });
  }
});
it("does not include other installations or unrelated Docker containers", async () => {
  const foreign = {
    ...row("desktop", "dead"),
    Labels: { "localdot.cell": "foreign", "localdot.role": "desktop" },
  };
  expect((await check([foreign])).detail).not.toContain("dead");
});
it("includes task containers only for this home", async () => {
  const brain = {
    Id: "c".repeat(64),
    State: "running",
    Labels: {
      "localdot.home": createHash("sha256").update(home).digest("hex").slice(0, 16),
      "localdot.role": "brain",
    },
  };
  expect((await check([brain])).detail).toContain("1 running");
});
it("keeps failed observations unknown rather than declaring the computer stopped", async () => {
  for (const rows of [
    null,
    [row("gate", "unknown")],
    [row("gate", "running"), row("gate", "running")],
  ]) {
    expect(await check(rows)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("could not be verified"),
    });
  }
  expect(await check([], true)).toMatchObject({ ok: false });
  const request = vi.fn(async () => {
    throw new Error("private diagnostic");
  });
  const result = await computerContainerCheck(
    { request } as unknown as DockerClient,
    home,
    async () => ({ records: [], invalid: false, digest: "test" }),
  );
  expect(result.detail).not.toContain("private diagnostic");
  expect(result.ok).toBe(false);
});
