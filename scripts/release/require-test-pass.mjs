import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function requireTestPass(report) {
  if (
    report.success !== true ||
    !(report.numTotalTests > 0) ||
    report.numPassedTests !== report.numTotalTests ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  )
    throw new Error(
      "Release checks must run and pass every selected test; skipped tests are not acceptance.",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: require-test-pass.mjs vitest-report.json");
  requireTestPass(JSON.parse(await readFile(process.argv[2], "utf8")));
}
