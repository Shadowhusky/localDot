import { expect, it } from "vitest";
import { count } from "./format.ts";

it("picks the singular or plural form by English plural rules", () => {
  expect(count(1, "file", "files")).toBe("1 file");
  expect(count(0, "file", "files")).toBe("0 files");
  expect(count(2, "reported call", "reported calls")).toBe("2 reported calls");
  expect(count(1422, "file", "files")).toBe(`${(1422).toLocaleString()} files`);
});
