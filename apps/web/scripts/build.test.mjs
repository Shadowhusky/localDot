import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishBuild } from "./build.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("publishes new dependencies and retains chunks referenced by open tabs", () => {
  const root = mkdtempSync(join(tmpdir(), "ld-publish-"));
  dirs.push(root);
  const staged = join(root, "staged"),
    live = join(root, "live");
  for (const dir of [staged, live]) mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(live, "assets/old.js"), "old chunk");
  writeFileSync(join(live, "index.html"), "old page");
  writeFileSync(join(staged, "assets/new.js"), "new chunk");
  writeFileSync(join(staged, "index.html"), '<script src="/assets/new.js"></script>');
  publishBuild(staged, live);
  expect(readFileSync(join(live, "assets/old.js"), "utf8")).toBe("old chunk");
  expect(readFileSync(join(live, "assets/new.js"), "utf8")).toBe("new chunk");
  expect(readFileSync(join(live, "index.html"), "utf8")).toContain("/assets/new.js");
});
it("requests the manifest with the pairing cookie", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toMatch(/rel="manifest"[^>]*crossorigin="use-credentials"/);
});
