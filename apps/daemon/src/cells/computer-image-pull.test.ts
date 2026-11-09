import { expect, it, vi } from "vitest";
import { SetupFailure } from "../../../cli/src/install/setup-failure.ts";
import { UpdateFailure } from "../updates/progress.ts";
import { pullPinnedImages } from "./computer-image-pull.ts";

const client = (pull: (...args: never[]) => Promise<void>) =>
  ({ engine: vi.fn(), inspect: vi.fn(), pull }) as never;
const GATE = `ghcr.io/shadowhusky/localdot-gate@sha256:${"a".repeat(64)}`;
const DESKTOP = `ghcr.io/shadowhusky/localdot-desktop@sha256:${"b".repeat(64)}`;

it("adds up the bytes Docker reports across every layer of every image", async () => {
  const seen: unknown[] = [];
  const pull = vi.fn(
    async (pin: { repository: string }, _signal: AbortSignal, report: (p: unknown) => void) => {
      report({ phase: "pulling", layer: "x" });
      report({ phase: "downloading", layer: "l1", currentBytes: 10, totalBytes: 100 });
      report({ phase: "downloading", layer: "l2", currentBytes: 5, totalBytes: 50 });
      if (pin.repository.endsWith("gate"))
        report({ phase: "extracting", layer: "l1", currentBytes: 1, totalBytes: 100 });
    },
  );
  await pullPinnedImages(
    [GATE, DESKTOP],
    new AbortController().signal,
    (p) => seen.push(p),
    client(pull as never),
  );
  expect(pull.mock.calls.map(([pin]) => pin)).toEqual([
    {
      repository: GATE.split("@")[0],
      digest: GATE.split("@")[1],
      platforms: [expect.stringMatching(/^linux\//)],
    },
    {
      repository: DESKTOP.split("@")[0],
      digest: DESKTOP.split("@")[1],
      platforms: [expect.stringMatching(/^linux\//)],
    },
  ]);
  expect(seen.at(2)).toEqual({ done: 15, total: 150 });
  expect(seen.at(3)).toEqual({ done: 105, total: 150 });
  expect(seen.at(-1)).toEqual({ done: 120, total: 300 });
});

it.each([
  ["storage-full", "disk"],
  ["network-unavailable", "network"],
  ["docker-unavailable", "docker"],
] as const)("names what stopped the download: %s", async (code, problem) => {
  const pull = vi.fn(async () => {
    throw new SetupFailure(code);
  });
  const failure = await pullPinnedImages(
    [GATE],
    new AbortController().signal,
    () => {},
    client(pull as never),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UpdateFailure);
  expect((failure as UpdateFailure).problem).toBe(problem);
});
