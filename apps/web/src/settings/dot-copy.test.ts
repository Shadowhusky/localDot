import { COPY_CATEGORIES, DEFAULT_COPY } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  COPY_CHOICES,
  chosenCopy,
  defaultCopy,
  dotNameProblem,
  passphraseProblem,
  toggled,
} from "./dot-copy.ts";

describe("what a new dot copies", () => {
  it("offers every category once, with the light ones on and the heavy or risky ones off", () => {
    expect(COPY_CHOICES.map((choice) => choice.id)).toEqual([...COPY_CATEGORIES]);
    expect(chosenCopy(defaultCopy())).toEqual([
      "settings",
      "keys",
      "memory",
      "skills",
      "connectors",
    ]);
    expect(chosenCopy(defaultCopy())).toEqual([...DEFAULT_COPY]);
    for (const off of ["conversations", "computer", "signins"] as const)
      expect(defaultCopy().has(off)).toBe(false);
  });

  it("says plainly what the large and risky ones cost", () => {
    const note = (id: string) => COPY_CHOICES.find((choice) => choice.id === id)?.note;
    expect(note("conversations")).toMatch(/large/);
    expect(note("computer")).toMatch(/must be stopped/);
    expect(note("signins")).toMatch(/sign each other out/);
  });

  it("asks for the categories in list order, however they were ticked", () => {
    let chosen = toggled(new Set(), "signins", true);
    chosen = toggled(chosen, "settings", true);
    chosen = toggled(chosen, "memory", true);
    chosen = toggled(chosen, "memory", false);
    expect(chosenCopy(chosen)).toEqual(["settings", "signins"]);
  });
});

describe("a new dot's name and passphrase", () => {
  it("wants a name of up to 40 letters, numbers and punctuation", () => {
    expect(dotNameProblem("  ")).toBe("Give the new dot a name.");
    expect(dotNameProblem("x".repeat(41))).toBe("Use up to 40 characters.");
    expect(dotNameProblem("a<b")).toBe("Use letters, numbers and punctuation.");
    expect(dotNameProblem(" Work ")).toBeNull();
  });

  it("wants a passphrase of 12 or more characters, typed the same twice", () => {
    expect(passphraseProblem("short", "short")).toBe("Use at least 12 characters.");
    expect(passphraseProblem("correct horse", "correct hors")).toBe("The passphrases don't match.");
    expect(passphraseProblem("é".repeat(600), "é".repeat(600))).toBe(
      "That passphrase is too long.",
    );
    expect(passphraseProblem("correct horse", "correct horse")).toBeNull();
  });
});
