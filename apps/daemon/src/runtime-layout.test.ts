import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveRuntimeLayout, runtimeLayout } from "./runtime-layout.ts";

it("preserves source-tree asset locations regardless of the caller or working directory", () => {
  const root = "/private/source folder's tree";
  expect(
    resolveRuntimeLayout(
      pathToFileURL(join(root, "apps/daemon/src/runtime-layout.ts")).href,
      false,
    ),
  ).toEqual({
    web: join(root, "apps/web"),
    skills: join(root, "skills"),
    browserSeccomp: join(root, "apps/daemon/src/cells/browser-seccomp.json"),
  });
  expect(runtimeLayout.web).toMatch(/\/apps\/web$/);
  expect(Object.isFrozen(runtimeLayout)).toBe(true);
});

it("locates every installed asset inside a relocated package with encoded file URL characters", () => {
  const root = "/private/installed app's folder/#hash%percent/localdot";
  expect(resolveRuntimeLayout(pathToFileURL(join(root, "dist/daemon.mjs")).href, true)).toEqual({
    web: join(root, "web"),
    skills: join(root, "skills"),
    browserSeccomp: join(root, "dist/browser-seccomp.json"),
  });
  expect(() => resolveRuntimeLayout("https://example.invalid/package", true)).toThrow();
});
