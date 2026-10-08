import { describe, expect, it } from "vitest";
import { fileName, splitAttachments, withAttachments } from "./attachments.ts";

describe("files named in a message", () => {
  it("adds the block only when there are files, and reads it back", () => {
    expect(withAttachments("Hi", [])).toBe("Hi");
    const text = withAttachments("Read these", ["~/Downloads/a.txt", "~/Downloads/b c.csv"]);
    expect(splitAttachments(text)).toEqual({
      body: "Read these",
      files: ["~/Downloads/a.txt", "~/Downloads/b c.csv"],
    });
    expect(fileName("~/Downloads/b c.csv")).toBe("b c.csv");
  });
  it("leaves a message alone when its end only looks like the block", () => {
    for (const text of [
      "Attached files on this computer:\n- a.txt",
      "Note\n\nAttached files on this computer:\n- a.txt\nand more words",
      "Note\n\nAttached files on this computer:\n- ",
    ])
      expect(splitAttachments(text)).toEqual({ body: text, files: [] });
  });
});
