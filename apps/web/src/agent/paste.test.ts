import { KEY_SCAN_CHARS, withAttachments } from "@localdot/protocol";
import { expect, it } from "vitest";
import { LONG_TEXT, longTextFile, pastedFiles, TEXT_BOUND, withoutKeyLike } from "./paste.ts";

const at = new Date(2026, 9, 15, 1, 2, 3);

it("names pasted pictures by time, apart within one second, and keeps real names", () => {
  const taken = new Set<string>();
  const shot = new File(["png"], "image.png", { type: "image/png" });
  const photo = new File(["jpg"], "", { type: "image/jpeg" });
  const named = new File(["x"], "plan.pdf", { type: "application/pdf" });
  expect(pastedFiles([shot, photo, named], taken, at).map((file) => file.name)).toEqual([
    "Pasted image 2026-10-15 01.02.03.png",
    "Pasted image 2026-10-15 01.02.03.jpg",
    "plan.pdf",
  ]);
  expect(pastedFiles([shot], taken, at)[0]?.name).toBe("Pasted image 2026-10-15 01.02.03 2.png");
});

it("makes a long text a file named for what it is, with its lines on its chip", () => {
  const taken = new Set<string>();
  const pasted = longTextFile("a\nb\nc", "pasted", taken, at);
  expect(pasted.file.name).toBe("Pasted text 2026-10-15 01.02.03.txt");
  expect(pasted.label).toBe("Pasted text · 3 lines");
  expect(longTextFile("a", "pasted", taken, at).file.name).toBe(
    "Pasted text 2026-10-15 01.02.03 2.txt",
  );
  const typed = longTextFile(`${"line\n".repeat(1239)}end`, "typed", taken, at);
  expect(typed.file.name).toBe("Long message 2026-10-15 01.02.03.txt");
  expect(typed.label).toBe("Long message · 1,240 lines");
  expect(longTextFile("one", "typed", taken, at).label).toBe("Long message · 1 line");
});

it("leaves room in the daemon's 8,000 characters and the key guard's reach", () => {
  expect(LONG_TEXT).toBeLessThan(TEXT_BOUND);
  expect(TEXT_BOUND).toBeLessThan(KEY_SCAN_CHARS);
  const names = Array.from(
    { length: 16 },
    (_, n) => `~/Downloads/Uploads/0b9f4c1e-6a2d-4f8b-9c3e-1d2a3b4c5d6e/report-${n}.pdf`,
  );
  expect(withAttachments("x".repeat(LONG_TEXT), names).length).toBeLessThanOrEqual(8000);
});

it("takes keys out of a text of any length, wherever they fall", () => {
  const log = "line of a long build log\n".repeat(800);
  expect(withoutKeyLike(log)).toEqual({ clean: log, removed: 0 });
  const key = `sk-proj-${"z".repeat(80)}`;
  for (const position of [100, 7_990, 15_000]) {
    const { clean, removed } = withoutKeyLike(
      `${log.slice(0, position)} ${key} ${log.slice(position)}`,
    );
    expect(removed).toBe(1);
    expect(clean).not.toContain(key);
    expect(clean.length).toBe(log.length + 2);
  }
  expect(withoutKeyLike(`${key} ${key}`)).toEqual({ clean: " ", removed: 2 });
});
