import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readServiceLogs, runLogs } from "./logs.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdot-log-read-")));
  roots.push(home);
  const state = join(home, "install"),
    directory = join(state, "logs");
  await mkdir(state, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const owner = { v: 1, id: "a".repeat(32), home, state, uid: process.getuid?.() };
  const record = join(state, "service-owner.json");
  await writeFile(record, JSON.stringify(owner), { mode: 0o600 });
  for (const name of ["daemon.log", "daemon.error.log", "keyd.log", "keyd.error.log"])
    await writeFile(join(directory, name), "", { mode: 0o600 });
  return { home, state, directory, file: join(directory, "daemon.log"), record, owner };
}
it("reads the last 100 lines per role and an unfinished final snapshot line without modifying files", async () => {
  const f = await fixture(),
    body = Array.from({ length: 120 }, (_, i) => `entry ${i}`).join("\n");
  await writeFile(f.file, body);
  await writeFile(join(f.directory, "keyd.error.log"), "key layer diagnostic\n");
  const batch = await readServiceLogs(f.home, {}, false, signal());
  expect(batch.lines[0]).toContain("100-line limit");
  expect(batch.lines[1]).toBe("[daemon.log] entry 20");
  expect(batch.lines.at(-2)).toBe("[daemon.log] entry 119");
  expect(batch.lines.at(-1)).toBe("[keyd.error.log] key layer diagnostic");
  expect(await readFile(f.file, "utf8")).toBe(body);
});
it("holds split credentials and UTF-8 until a complete line, then emits once", async () => {
  const f = await fixture();
  await writeFile(f.file, 'authorization="Bearer private');
  const first = await readServiceLogs(f.home, {}, true, signal());
  expect(first.lines).toEqual([]);
  await appendFile(f.file, '-credential" 中文\n');
  const next = await readServiceLogs(f.home, first.cursors, true, signal(), first.owner);
  expect(next.lines).toEqual(["[daemon.log] authorization=[redacted] 中文"]);
  expect((await readServiceLogs(f.home, next.cursors, true, signal(), next.owner)).lines).toEqual(
    [],
  );
  const bytes = Buffer.from("中文\n");
  await appendFile(f.file, bytes.subarray(0, 2));
  const partial = await readServiceLogs(f.home, next.cursors, true, signal(), next.owner);
  expect(partial.lines).toEqual([]);
  await appendFile(f.file, bytes.subarray(2));
  expect(
    (await readServiceLogs(f.home, partial.cursors, true, signal(), partial.owner)).lines,
  ).toEqual(["[daemon.log] 中文"]);
});
it("reopens validated rotation and truncation and never joins an old partial line to a new file", async () => {
  const f = await fixture();
  await writeFile(f.file, "old partial");
  const first = await readServiceLogs(f.home, {}, true, signal());
  await rename(f.file, `${f.file}.old`);
  await writeFile(f.file, "new\n", { mode: 0o600 });
  const rotated = await readServiceLogs(f.home, first.cursors, true, signal(), first.owner);
  expect(rotated.lines).toEqual(["[daemon.log] Log rotated or truncated.", "[daemon.log] new"]);
  await truncate(f.file);
  await appendFile(f.file, "x\n");
  expect(
    (await readServiceLogs(f.home, rotated.cursors, true, signal(), first.owner)).lines,
  ).toEqual(["[daemon.log] Log rotated or truncated.", "[daemon.log] x"]);
});
it("bounds backlog and omits cut leading lines and oversized lines including split tails", async () => {
  const f = await fixture();
  await writeFile(f.file, `${"private".repeat(20_000)}\nsafe\n`);
  const first = await readServiceLogs(f.home, {}, true, signal());
  expect(first.lines).toEqual([
    "[daemon.log] Older output omitted (read window limit).",
    "[daemon.log] safe",
  ]);
  await appendFile(f.file, "x".repeat(17_000));
  const long = await readServiceLogs(f.home, first.cursors, true, signal(), first.owner);
  expect(long.lines).toEqual(["[daemon.log] Oversized log line omitted."]);
  await appendFile(f.file, "secret-end\nnext\n");
  const finished = await readServiceLogs(f.home, long.cursors, true, signal(), first.owner);
  expect(finished.lines).toEqual(["[daemon.log] next"]);
  expect(finished.cursors["daemon.log"]?.pending.length).toBe(0);
});
it.each([
  "file-mode",
  "directory-mode",
  "symlink",
  "hardlink",
  "directory-file",
  "owner-mismatch",
  "owner-change",
])("refuses %s before emitting any log batch", async (kind) => {
  const f = await fixture();
  await writeFile(f.file, "sensitive diagnostic\n");
  if (kind === "file-mode") await chmod(f.file, 0o644);
  if (kind === "directory-mode") await chmod(f.directory, 0o755);
  if (kind === "symlink") {
    await rename(f.file, `${f.file}.saved`);
    await symlink(`${f.file}.saved`, f.file);
  }
  if (kind === "hardlink") await link(f.file, `${f.file}.other`);
  if (kind === "directory-file") {
    await unlink(f.file);
    await mkdir(f.file, { mode: 0o600 });
  }
  if (kind === "owner-mismatch")
    await writeFile(f.record, JSON.stringify({ ...f.owner, home: f.state }));
  const expected = kind === "owner-change" ? "b".repeat(32) : undefined;
  await expect(readServiceLogs(f.home, {}, false, signal(), expected)).rejects.toThrow();
});
it("reports missing files once while following and notices their later creation", async () => {
  const f = await fixture();
  await unlink(f.file);
  const first = await readServiceLogs(f.home, {}, true, signal());
  expect(first.lines).toEqual(["[daemon.log] Log has not been created yet."]);
  const next = await readServiceLogs(f.home, first.cursors, true, signal(), first.owner);
  expect(next.lines).toEqual([]);
  await writeFile(f.file, "created\n", { mode: 0o600 });
  expect((await readServiceLogs(f.home, next.cursors, true, signal(), first.owner)).lines).toEqual([
    "[daemon.log] created",
  ]);
});
it("runs follow until interrupted, with no further output after cancellation", async () => {
  const f = await fixture();
  await writeFile(f.file, "first\n");
  const controller = new AbortController(),
    io = { out: vi.fn(), err: vi.fn() };
  const done = runLogs({ home: f.home, signal: controller.signal, follow: true }, io);
  await vi.waitFor(() => expect(io.out).toHaveBeenCalledWith("[daemon.log] first"));
  await appendFile(f.file, "second\n");
  await vi.waitFor(() => expect(io.out).toHaveBeenCalledWith("[daemon.log] second"), {
    timeout: 1500,
  });
  controller.abort();
  expect(await done).toBe(130);
  expect(io.err).not.toHaveBeenCalled();
  expect(io.out).toHaveBeenCalledTimes(2);
});
it("handles empty logs, missing install and pre-cancellation without raw path errors", async () => {
  const f = await fixture(),
    io = { out: vi.fn(), err: vi.fn() };
  expect(await runLogs({ home: f.home, signal: signal(), follow: false }, io)).toBe(0);
  expect(io.out).toHaveBeenCalledWith("No service log entries yet.");
  expect(
    await runLogs(
      { home: join(f.home, "missing-private-path"), signal: signal(), follow: false },
      io,
    ),
  ).toBe(1);
  expect(JSON.stringify(io.err.mock.calls)).not.toContain("missing-private-path");
  const controller = new AbortController();
  controller.abort();
  expect(await runLogs({ home: f.home, signal: controller.signal, follow: true }, io)).toBe(130);
});
