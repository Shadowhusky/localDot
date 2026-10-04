import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  runs: [] as Array<(args: unknown, info: unknown) => Promise<void>>,
  process: vi.fn(),
}));
vi.mock("@playwright/test", () => ({
  test: (_name: string, run: (args: unknown, info: unknown) => Promise<void>) =>
    seam.runs.push(run),
  expect: () => {
    throw new Error("Unexpected downstream browser assertion");
  },
}));
vi.mock("../../e2e/fixtures/assembled-process.ts", () => ({ assembledProcess: seam.process }));
await import("../../e2e/assembled-app.docker.spec.ts");

const root = join(
  process.env.LOCALDOT_TASK14_REVIEW_DIR ?? "/private/tmp/localdot-m4-ui-task14-review/full",
  "inert-lifecycle-fixtures",
);
mkdirSync(root, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(root, "owned-"));
  const runtime = {
    url: "http://127.0.0.1:1/#token=inert-fixture",
    close: vi.fn(async () => {}),
    state: vi.fn(async () => []),
  };
  const page = {
    on: vi.fn(),
    exposeFunction: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {}),
    viewportSize: () => ({ width: 1440, height: 900 }),
    goto: vi.fn(async () => {
      throw new Error("inert navigation failure");
    }),
    isClosed: () => false,
    locator: () => ({ innerText: async () => "inert diagnostic body" }),
    screenshot: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const info = { outputPath: (name: string) => join(dir, name) };
  seam.process.mockResolvedValue(runtime);
  return { runtime, page, info, run: () => seam.runs[0]?.({ page }, info) };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

it("positive control: ordinary navigation failure still closes page and owned runtime", async () => {
  const f = fixture();
  await expect(f.run()).rejects.toThrow("inert navigation failure");
  expect(f.page.close).toHaveBeenCalledOnce();
  expect(f.runtime.close).toHaveBeenCalledOnce();
});

it("retires the owned runtime when page setup fails after worker acquisition", async () => {
  const f = fixture();
  f.page.exposeFunction.mockRejectedValue(new Error("inert expose failure"));
  await expect(f.run()).rejects.toThrow("inert expose failure");
  expect(
    f.runtime.close,
    "setup failure must still retire the acquired worker",
  ).toHaveBeenCalledOnce();
});

it("attempts runtime retirement even if page.close rejects", async () => {
  const f = fixture();
  f.page.close.mockRejectedValue(new Error("inert page-close failure"));
  await expect(f.run()).rejects.toThrow();
  expect(
    f.runtime.close,
    "one owner failure must not skip the worker owner",
  ).toHaveBeenCalledOnce();
});

it("diagnostic artifact failure cannot skip page and worker retirement", async () => {
  const f = fixture();
  f.info.outputPath = () => {
    throw new Error("inert artifact-path failure");
  };
  await expect(f.run()).rejects.toThrow("inert artifact-path failure");
  expect.soft(f.page.close).toHaveBeenCalledOnce();
  expect.soft(f.runtime.close).toHaveBeenCalledOnce();
});
