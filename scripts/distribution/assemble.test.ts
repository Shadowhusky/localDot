import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { packageNotes } from "./assemble.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function candidate(notes: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "dot-assemble-notes-"));
  roots.push(dir);
  await mkdir(join(dir, "app", "release-notes"), { recursive: true });
  const files: Record<string, { sha256: string }> = { "dist/cli.mjs": { sha256: "a".repeat(64) } };
  for (const [version, markdown] of Object.entries(notes)) {
    await writeFile(join(dir, "app", "release-notes", `${version}.md`), markdown);
    files[`release-notes/${version}.md`] = {
      sha256: createHash("sha256").update(markdown).digest("hex"),
    };
  }
  return { dir, receipt: { version: "0.1.0-rc.21", artifact: { files } } };
}

it("signs the package's own notes, newest first, and requires the release's", async () => {
  const c = await candidate({
    "0.1.0-rc.20": "## Fixes\n\n- An older fix.\n",
    "0.1.0-rc.21": "## What's new\n\n- Something new.\n",
  });
  expect(await packageNotes(c.dir, c.receipt)).toEqual([
    { version: "0.1.0-rc.21", markdown: "## What's new\n\n- Something new." },
    { version: "0.1.0-rc.20", markdown: "## Fixes\n\n- An older fix." },
  ]);
  const missing = await candidate({ "0.1.0-rc.20": "## Fixes\n\n- An older fix.\n" });
  await expect(packageNotes(missing.dir, missing.receipt)).rejects.toThrow(
    "docs/releases/0.1.0-rc.21.md",
  );
});
it("refuses notes that break the rules or changed after the build", async () => {
  const bad = await candidate({ "0.1.0-rc.21": "## Fixes\n\n- The keyd refactor landed.\n" });
  await expect(packageNotes(bad.dir, bad.receipt)).rejects.toThrow("need work");
  const changed = await candidate({ "0.1.0-rc.21": "## Fixes\n\n- One fix.\n" });
  await writeFile(join(changed.dir, "app/release-notes/0.1.0-rc.21.md"), "## Fixes\n\n- Two.\n");
  await expect(packageNotes(changed.dir, changed.receipt)).rejects.toThrow("changed");
});
