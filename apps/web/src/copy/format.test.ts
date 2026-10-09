import { expect, it } from "vitest";
import { bytes, clock, count, spendText } from "./format.ts";

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
  expect(bytes(2.1 * 1024 * 1024 * 1024)).toBe("2.1 GB");
});

it("shows stated money plainly and estimates with ≈, to the cent or below it", () => {
  expect(spendText(0.21, false)).toBe("$0.21");
  expect(spendText(23.4, true)).toBe("≈\u00a0$23.40");
  expect(spendText(1234.5, false)).toBe("$1,234.50");
  expect(spendText(0.0042, true)).toBe("≈\u00a0$0.004");
  expect(spendText(0.0004, false)).toBe("< $0.001");
  expect(spendText(0, false)).toBe("$0.00");
});

it("shows a running time as m:ss under an hour and h:mm:ss from one hour", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(42.9)).toBe("0:42");
  expect(clock(102)).toBe("1:42");
  expect(clock(3599)).toBe("59:59");
  expect(clock(3600)).toBe("1:00:00");
  expect(clock(3665)).toBe("1:01:05");
  expect(clock(36_005)).toBe("10:00:05");
  expect(clock(-3)).toBe("0:00");
});
