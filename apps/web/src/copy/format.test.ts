import { expect, it } from "vitest";
import { bytes, count } from "./format.ts";

it("picks the singular or plural form by English plural rules", () => {
  expect(count(1, "file", "files")).toBe("1 file");
  expect(count(0, "file", "files")).toBe("0 files");
  expect(count(2, "reported call", "reported calls")).toBe("2 reported calls");
  expect(count(1422, "file", "files")).toBe(`${(1422).toLocaleString()} files`);
});

it("sizes files in bytes, then KB and MB", () => {
  expect(bytes(1)).toBe("1 byte");
  expect(bytes(48)).toBe("48 bytes");
  expect(bytes(1536)).toBe("1.5 KB");
  expect(bytes(3 * 1024 * 1024)).toBe("3.0 MB");
});
