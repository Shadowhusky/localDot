import { describe, expect, it } from "vitest";
import { BANNED_COPY, bannedWords } from "./banned.ts";

describe("banned copy", () => {
  it("finds internal words in a sentence, whatever their case", () => {
    expect(bannedWords("localDot's daemon isn't answering.")).toEqual(["daemon"]);
    expect(bannedWords("Start keyd, then resume.")).toEqual(["keyd"]);
    expect(bannedWords("No Sessions yet")).toEqual(["sessions"]);
    expect(bannedWords("Use Stop to contain it")).toEqual(["contain"]);
  });

  it("matches a phrase across any spacing", () => {
    expect(bannedWords("Frozen model\nidentity")).toEqual(["frozen model identity"]);
    expect(bannedWords("Resume  computer")).toEqual(["resume computer"]);
  });

  it("leaves class names, paths, identifiers and longer words alone", () => {
    for (const text of [
      "cell-row",
      "/api/cells",
      "obj.session",
      "cell_id",
      "excellent",
      "contains",
    ]) {
      expect(bannedWords(text), text).toEqual([]);
    }
  });

  it("bans audit words only in headings and on buttons", () => {
    expect(bannedWords("Verified by your bank")).toEqual([]);
    expect(bannedWords("Verified", true)).toEqual(["verified"]);
    expect(bannedWords("Your files are retained", true)).toEqual(["retained"]);
  });

  it("lists each word once, in lower case", () => {
    expect(new Set(BANNED_COPY).size).toBe(BANNED_COPY.length);
    for (const word of BANNED_COPY) expect(word).toBe(word.toLowerCase());
  });
});
