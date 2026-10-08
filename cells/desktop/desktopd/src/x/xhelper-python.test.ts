import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const TESTS = fileURLToPath(new URL("../../x/xhelper_test.py", import.meta.url));
const python = spawnSync("python3", ["--version"]).status === 0;

// The helper's settle policy and window tracking, with Xlib stubbed and a fake
// clock: python-xlib itself only exists in the desktop image.
it.skipIf(!python)("passes the X helper's Python unit tests", () => {
  const run = spawnSync("python3", ["-I", "-B", TESTS], { encoding: "utf8", timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
});
