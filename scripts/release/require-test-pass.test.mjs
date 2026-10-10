import { expect, it } from "vitest";
import { requireTestPass } from "./require-test-pass.mjs";

const passed = {
  success: true,
  numTotalTests: 4,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
};
it("accepts only a nonempty complete passing run", () => {
  expect(() => requireTestPass(passed)).not.toThrow();
  for (const override of [
    { success: false },
    { numTotalTests: 0 },
    { numPendingTests: 1 },
    { numTodoTests: 1 },
    { numPassedTests: 3 },
    { numFailedTests: 1 },
  ])
    expect(() => requireTestPass({ ...passed, ...override })).toThrow();
});
