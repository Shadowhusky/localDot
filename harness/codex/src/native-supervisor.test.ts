import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveNativeSupervisor } from "./native-supervisor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/localdot-supervisor-layout-"));
  roots.push(root);
  const dir = join(root, "keyd", "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "keyd-native");
  writeFileSync(path, "inert helper", { mode: 0o700 });
  const url = pathToFileURL(join(root, "app", "dist", "daemon.mjs")).href;
  return { root, path, url };
}
it("selects only the fixed authenticated release's helper location", () => {
  const f = fixture();
  expect(resolveNativeSupervisor(f.url, true)).toBe(f.path);
  expect(resolveNativeSupervisor(f.url, false)).toBeUndefined();
});
it.each(["missing", "symlink", "hardlink", "writable", "not-executable", "empty"])(
  "refuses %s helpers without a production fallback",
  (kind) => {
    const f = fixture();
    if (kind === "missing") rmSync(f.path);
    if (kind === "symlink") {
      rmSync(f.path);
      symlinkSync(process.execPath, f.path);
    }
    if (kind === "hardlink") linkSync(f.path, join(f.root, "alias"));
    if (kind === "writable") chmodSync(f.path, 0o777);
    if (kind === "not-executable") chmodSync(f.path, 0o600);
    if (kind === "empty") writeFileSync(f.path, "");
    expect(() => resolveNativeSupervisor(f.url, true)).toThrow("native supervisor");
  },
);
