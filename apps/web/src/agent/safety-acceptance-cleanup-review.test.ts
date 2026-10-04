import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  runs: [] as Array<(args: { page: unknown }, info: unknown) => Promise<void>>,
  process: vi.fn(),
  start: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@playwright/test", async () => ({
  test: (_name: string, run: (args: { page: unknown }, info: unknown) => Promise<void>) =>
    seam.runs.push(run),
  expect: (await import("vitest")).expect,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeFileSync: seam.write,
}));
vi.mock("../../e2e/fixtures/assembled-process.ts", () => ({ assembledProcess: seam.process }));
vi.mock("../../e2e/fixtures/safety-flow.ts", () => ({
  startSafetyTask: seam.start,
  fixtureRequest: vi.fn(),
  approveCurrent: vi.fn(),
  answerTable: vi.fn(),
  showPane: vi.fn(),
}));
await import("../../e2e/safety.docker.spec.ts");

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const runtime = { close: vi.fn(async () => {}) };
  const page = {
    on: vi.fn(),
    addInitScript: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    evaluate: vi.fn(async () => ({ focus: [], samples: [] })),
  };
  const info = { outputPath: () => "inert-no-file-is-written.json" };
  seam.write.mockImplementation(() => {});
  seam.start.mockRejectedValue(new Error("inert body failure"));
  seam.process.mockResolvedValue(runtime);
  const run = seam.runs[0];
  if (!run) throw new Error("Actual safety acceptance callback was not captured");
  return { runtime, page, info, run: () => run({ page }, info) };
}

it("positive: a body failure still retires the acquired safety worker", async () => {
  const f = fixture();
  await expect(f.run()).rejects.toThrow("inert body failure");
  expect(f.runtime.close).toHaveBeenCalledOnce();
});
it("setup failure after acquisition cannot skip the safety worker owner", async () => {
  const f = fixture();
  f.page.addInitScript.mockRejectedValue(new Error("inert setup failure"));
  await expect(f.run()).rejects.toThrow();
  expect(
    f.runtime.close,
    "the acquired worker must retire after page setup rejects",
  ).toHaveBeenCalledOnce();
});
it("diagnostic evaluate failure cannot skip the safety worker owner", async () => {
  const f = fixture();
  f.page.evaluate.mockRejectedValue(new Error("inert diagnostic evaluation failure"));
  await expect(f.run()).rejects.toThrow();
  expect(
    f.runtime.close,
    "diagnostics are independent of runtime retirement",
  ).toHaveBeenCalledOnce();
});
it("diagnostic file failure cannot skip the safety worker owner", async () => {
  const f = fixture();
  seam.write.mockImplementation(() => {
    throw new Error("inert artifact write failure");
  });
  await expect(f.run()).rejects.toThrow();
  expect(
    f.runtime.close,
    "artifact write failure must not strand the worker",
  ).toHaveBeenCalledOnce();
});
it("positive: an already closed page still retires the safety worker", async () => {
  const f = fixture();
  f.page.isClosed.mockReturnValue(true);
  await expect(f.run()).rejects.toThrow("inert body failure");
  expect(f.page.evaluate).not.toHaveBeenCalled();
  expect(f.runtime.close).toHaveBeenCalledOnce();
});
