import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const python = spawnSync("python3", ["--version"]).status === 0;
const run = (file: string) =>
  spawnSync("python3", ["-I", "-B", fileURLToPath(new URL(`../../x/${file}`, import.meta.url))], {
    encoding: "utf8",
    timeout: 60_000,
  });

// The helpers' Python unit tests, with Xlib and AT-SPI stubbed and a fake clock: python-xlib and
// PyGObject only exist in the desktop image.
it.skipIf(!python)("passes the X helper's Python unit tests", () => {
  const result = run("xhelper_test.py");
  expect(result.status, result.stderr).toBe(0);
});

it.skipIf(!python)("passes the accessibility helper's Python unit tests", () => {
  const result = run("native_test.py");
  expect(result.status, result.stderr).toBe(0);
});
