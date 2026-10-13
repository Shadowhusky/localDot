import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopCapabilities } from "./capabilities.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home() {
  const h = await mkdtemp(join(tmpdir(), "localdot-capabilities-"));
  homes.push(h);
  return h;
}
describe("desktop inventory without command execution", () => {
  it("recognizes executable files and links, excluding directories and non-executables", async () => {
    const h = await home();
    await writeFile(join(h, "git"), "#!/bin/sh\necho executed > should-not-exist\n", {
      mode: 0o755,
    });
    await symlink(join(h, "git"), join(h, "gh"));
    await writeFile(join(h, "node"), "not executable", { mode: 0o644 });
    await mkdir(join(h, "python3"));
    await writeFile(join(h, ".bash_profile"), "touch should-not-exist\n");
    const result = await desktopCapabilities(h, new AbortController().signal);
    expect(result.programs).toMatchObject({
      git: "available",
      gh: "available",
      node: "not_on_path",
      python3: "not_on_path",
      curl: "not_on_path",
    });
    await expect(readFile(join(h, "should-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(join(h, "git"), 0o644);
    expect((await desktopCapabilities(h, new AbortController().signal)).programs.git).toBe(
      "not_on_path",
    );
  });
  it("reports unknown for absent, relative, or truncated PATH entries", async () => {
    const h = await home();
    for (const path of [
      undefined,
      "relative",
      `${h}:`,
      Array.from({ length: 33 }, (_, i) => `${h}/${i}`).join(":"),
    ])
      expect((await desktopCapabilities(path, new AbortController().signal)).programs.git).toBe(
        "unknown",
      );
  });
  it("honors cancellation before metadata reads", async () => {
    const signal = AbortSignal.abort(new Error("stopped"));
    await expect(desktopCapabilities("/bin", signal)).rejects.toThrow("stopped");
  });
});
