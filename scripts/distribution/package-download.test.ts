import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { downloadPackage, PackageProblem } from "./package-download.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const BYTES = Buffer.alloc(1024 * 1024, 7).map((_, i) => i % 251);
const artifact = {
  url: "https://example.test/app.tgz",
  bytes: BYTES.length,
  sha512: createHash("sha512").update(BYTES).digest("hex"),
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dot-package-download-"));
  roots.push(root);
  return { root, to: join(root, "app.tgz"), partials: join(root, "partials") };
}
const stream = (...parts: (Uint8Array | Error)[]) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = parts.shift();
      if (!next) return controller.close();
      if (next instanceof Error) return controller.error(next);
      controller.enqueue(next);
    },
  });
function answer(body: ReadableStream<Uint8Array> | null, status = 200, range?: string) {
  const response = new Response(body, { status, headers: range ? { "content-range": range } : {} });
  Object.defineProperty(response, "url", { value: artifact.url });
  return response;
}
const OPTIONS = { waitMs: 0 };
const PART = `app-${artifact.sha512.slice(0, 16)}.part`;

it("resumes from what it has after the connection drops, and checks the whole file", async () => {
  const f = fixture();
  const half = BYTES.length / 2;
  const seen: number[] = [];
  const fetchFile = vi
    .fn()
    .mockResolvedValueOnce(answer(stream(BYTES.subarray(0, half), new Error("reset"))))
    .mockResolvedValueOnce(
      answer(stream(BYTES.subarray(half)), 206, `bytes ${half}-${BYTES.length - 1}/${BYTES.length}`),
    );
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    fetch: fetchFile,
    signal: new AbortController().signal,
    report: (done) => seen.push(done),
  });
  expect(fetchFile.mock.calls[0]?.[1].headers.range).toBeUndefined();
  expect(fetchFile.mock.calls[1]?.[1].headers.range).toBe(`bytes=${half}-`);
  expect(readFileSync(f.to).equals(BYTES)).toBe(true);
  expect(seen.at(-1)).toBe(BYTES.length);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(statSync(f.to).mode & 0o777).toBe(0o400);
  expect(readdirSync(f.partials)).toEqual([]);
});
it("carries on from an earlier run's partial file, as after a daemon crash", async () => {
  const f = fixture();
  const half = BYTES.length / 2;
  mkdirSync(f.partials);
  writeFileSync(join(f.partials, PART), BYTES.subarray(0, half));
  const fetchFile = vi
    .fn()
    .mockResolvedValue(
      answer(stream(BYTES.subarray(half)), 206, `bytes ${half}-${BYTES.length - 1}/${BYTES.length}`),
    );
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    fetch: fetchFile,
    signal: new AbortController().signal,
    report: () => {},
  });
  expect(fetchFile.mock.calls[0]?.[1].headers.range).toBe(`bytes=${half}-`);
  expect(readFileSync(f.to).equals(BYTES)).toBe(true);
});
it("starts over when the server ignores the range", async () => {
  const f = fixture();
  const half = BYTES.length / 2;
  const fetchFile = vi
    .fn()
    .mockResolvedValueOnce(answer(stream(BYTES.subarray(0, half), new Error("reset"))))
    .mockResolvedValueOnce(answer(stream(BYTES)));
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    fetch: fetchFile,
    signal: new AbortController().signal,
    report: () => {},
  });
  expect(readFileSync(f.to).equals(BYTES)).toBe(true);
});
it("throws a corrupt partial away and fetches it whole, once", async () => {
  const f = fixture();
  const fetchFile = vi
    .fn()
    .mockResolvedValueOnce(answer(stream(Buffer.alloc(BYTES.length, 9))))
    .mockResolvedValueOnce(answer(stream(BYTES)));
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    fetch: fetchFile,
    signal: new AbortController().signal,
    report: () => {},
  });
  expect(readFileSync(f.to).equals(BYTES)).toBe(true);
  const bad = fixture();
  await expect(
    downloadPackage({
      ...artifact,
      ...OPTIONS,
      to: bad.to,
      partials: bad.partials,
      fetch: vi.fn().mockImplementation(async () => answer(stream(Buffer.alloc(BYTES.length, 9)))),
      signal: new AbortController().signal,
      report: () => {},
    }),
  ).rejects.toMatchObject({ problem: "verify" });
});
it("stops a download that has gone quiet, and names the stall", async () => {
  const f = fixture();
  const failure = await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    stallMs: 20,
    attempts: 2,
    fetch: vi.fn().mockImplementation(
      async (_url: string, init: { signal: AbortSignal }) =>
        answer(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(BYTES.subarray(0, 10));
              init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
            },
          }),
        ),
    ),
    signal: new AbortController().signal,
    report: () => {},
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PackageProblem);
  expect((failure as PackageProblem).problem).toBe("stalled");
});
it("keeps trying while it gets anywhere, and gives up on a dead connection", async () => {
  const f = fixture();
  const dead = vi.fn().mockRejectedValue(new Error("fetch failed"));
  await expect(
    downloadPackage({
      ...artifact,
      ...OPTIONS,
      to: f.to,
      partials: f.partials,
      fetch: dead,
      signal: new AbortController().signal,
      report: () => {},
    }),
  ).rejects.toMatchObject({ problem: "network" });
  expect(dead).toHaveBeenCalledTimes(4);
  const slice = BYTES.length / 8;
  const flaky = vi.fn().mockImplementation(async (_url: string, init: { headers: { range?: string } }) => {
    const from = Number(init.headers.range?.match(/\d+/)?.[0] ?? 0);
    return from
      ? answer(
          stream(BYTES.subarray(from, from + slice), new Error("reset")),
          206,
          `bytes ${from}-${BYTES.length - 1}/${BYTES.length}`,
        )
      : answer(stream(BYTES.subarray(0, slice), new Error("reset")));
  });
  const again = fixture();
  await expect(
    downloadPackage({
      ...artifact,
      ...OPTIONS,
      to: again.to,
      partials: again.partials,
      fetch: flaky,
      signal: new AbortController().signal,
      report: () => {},
    }),
  ).resolves.toBeUndefined();
  expect(flaky.mock.calls.length).toBeGreaterThan(4);
});
it("says the disk is full when it is", async () => {
  const f = fixture();
  // A partial path that cannot be written stands in for a full disk's write error.
  const full = Object.assign(new Error("no space"), { code: "ENOSPC" });
  await expect(
    downloadPackage({
      ...artifact,
      ...OPTIONS,
      to: f.to,
      partials: f.partials,
      open: () => {
        throw full;
      },
      fetch: vi.fn().mockResolvedValue(answer(stream(BYTES))),
      signal: new AbortController().signal,
      report: () => {},
    }),
  ).rejects.toMatchObject({ problem: "disk" });
});
it("refuses to start without room for the package and its files", async () => {
  const f = fixture();
  const fetchFile = vi.fn();
  await expect(
    downloadPackage({
      ...artifact,
      ...OPTIONS,
      to: f.to,
      partials: f.partials,
      needs: 10_000,
      freeBytes: () => 9_000,
      fetch: fetchFile,
      signal: new AbortController().signal,
      report: () => {},
    }),
  ).rejects.toMatchObject({ problem: "disk" });
  expect(fetchFile).not.toHaveBeenCalled();
});
it("clears what an older version left, and a size past the release", async () => {
  const f = fixture();
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: join(f.root, "x.tgz"),
    partials: f.partials,
    fetch: vi.fn().mockResolvedValue(answer(stream(BYTES))),
    signal: new AbortController().signal,
    report: () => {},
  });
  const stale = join(f.partials, "app-0000000000000000.part");
  writeFileSync(stale, "old");
  const oversize = join(f.partials, PART);
  writeFileSync(oversize, Buffer.alloc(BYTES.length + 10));
  const fetchFile = vi.fn().mockResolvedValue(answer(stream(BYTES)));
  await downloadPackage({
    ...artifact,
    ...OPTIONS,
    to: f.to,
    partials: f.partials,
    fetch: fetchFile,
    signal: new AbortController().signal,
    report: () => {},
  });
  expect(fetchFile.mock.calls[0]?.[1].headers.range).toBeUndefined();
  expect(readdirSync(f.partials)).toEqual([]);
});
