import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateJournalStore } from "./update-journal.ts";
import {
  recoverUpdate,
  type UpdateJournal,
  type UpdateTransactionHost,
} from "./update-transaction.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const record = (): UpdateJournal => ({
  v: 1,
  id: "e7d79215-1b76-42dd-aede-d8c3c4ac2cd3",
  phase: "prepared",
  previous: { version: "1.0.0", packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
  candidate: { version: "1.1.0", packageSha256: "c".repeat(64), manifestSha256: "d".repeat(64) },
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-journal-")));
  roots.push(root);
  await chmod(root, 0o700);
  return { root, file: join(root, "update.json"), store: updateJournalStore(root) };
}
it("atomically replaces a private record, reopens independently, and leaves no temp files", async () => {
  const f = await fixture();
  expect(await f.store.read()).toBeNull();
  const journal = record();
  await f.store.save(journal);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  const inode = (await stat(f.file)).ino;
  journal.phase = "validating";
  await f.store.save(journal);
  expect((await stat(f.file)).ino).not.toBe(inode);
  expect(await updateJournalStore(f.root).read()).toEqual(journal);
  expect(await readdir(f.root)).toEqual(["update.json"]);
});
it.each(["symlink", "hardlink", "directory", "mode", "oversized", "invalid"])(
  "refuses a %s recovery record without overwriting it",
  async (kind) => {
    const f = await fixture();
    if (kind === "directory") await mkdir(f.file);
    else if (kind === "symlink" || kind === "hardlink") {
      const target = join(f.root, "original");
      await writeFile(target, JSON.stringify(record()), { mode: 0o600 });
      await (kind === "symlink" ? symlink : link)(target, f.file);
    } else {
      await writeFile(
        f.file,
        kind === "invalid"
          ? "{}"
          : kind === "oversized"
            ? " ".repeat(16385)
            : JSON.stringify(record()),
        { mode: kind === "mode" ? 0o644 : 0o600 },
      );
    }
    const before = kind === "directory" ? null : await readFile(f.file);
    await expect(f.store.read()).rejects.toThrow("unsafe");
    await expect(f.store.save(record())).rejects.toThrow("unsafe");
    if (before) expect(await readFile(f.file)).toEqual(before);
  },
);
it("requires an existing private canonical directory and never creates it", async () => {
  const f = await fixture();
  const absent = join(f.root, "absent");
  await expect(updateJournalStore(absent).save(record())).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
  await chmod(f.root, 0o755);
  await expect(f.store.read()).rejects.toThrow("unsafe");
  await chmod(f.root, 0o700);
  const linked = join(f.root, "linked");
  await symlink(f.root, linked);
  await expect(updateJournalStore(linked).read()).rejects.toThrow("unsafe");
});
it("recovers a persisted interrupted update using a freshly opened store", async () => {
  const f = await fixture();
  const journal = record();
  journal.phase = "validating";
  await f.store.save(journal);
  let selected = journal.candidate;
  const events: string[] = [];
  const host: UpdateTransactionHost = {
    ...updateJournalStore(f.root),
    async current() {
      return selected;
    },
    async verify(r) {
      events.push(`verify:${r.version}`);
    },
    async quiesce() {
      events.push("quiesce");
    },
    async select(r) {
      if (!r) throw new Error("unexpected null");
      selected = r;
      events.push(`select:${r.version}`);
    },
    async start(r) {
      events.push(`start:${r.version}`);
    },
    async healthy(r) {
      events.push(`healthy:${r.version}`);
    },
  };
  expect((await recoverUpdate(host))?.phase).toBe("rolled-back");
  expect(events).toEqual([
    "quiesce",
    "verify:1.0.0",
    "select:1.0.0",
    "start:1.0.0",
    "healthy:1.0.0",
  ]);
  expect((await updateJournalStore(f.root).read())?.phase).toBe("rolled-back");
  expect(await readdir(f.root)).toEqual(["update.json"]);
});
