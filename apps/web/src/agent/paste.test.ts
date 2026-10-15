import { expect, it } from "vitest";
import { LONG_PASTE, pastedFiles, pastedName, pastedText } from "./paste.ts";

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

it("makes a long text a file only when the key guard has nothing to say", () => {
  const taken = new Set<string>();
  expect(pastedText("short", taken, at)).toBeNull();
  const file = pastedText("x".repeat(LONG_PASTE + 1), taken, at);
  expect(file?.name).toBe("Pasted text 2026-10-15 01.02.03.txt");
  expect(pastedText(`${"x ".repeat(LONG_PASTE)} sk-proj-${"z".repeat(80)}`, taken, at)).toBeNull();
  expect(pastedName("text", "txt", taken, at)).toBe("Pasted text 2026-10-15 01.02.03 2.txt");
});

it("reads a long text for keys window by window, so a long log becomes a file", () => {
  const taken = new Set<string>();
  const log = "line of a long build log\n".repeat(800);
  expect(pastedText(log, taken, at)?.size).toBe(log.length);
  const key = `sk-proj-${"z".repeat(80)}`;
  for (const position of [100, 7_990, 15_000])
    expect(
      pastedText(`${log.slice(0, position)}${key}${log.slice(position)}`, taken, at),
    ).toBeNull();
});
