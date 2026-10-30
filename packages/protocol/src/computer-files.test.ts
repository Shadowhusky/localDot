import { describe, expect, it } from "vitest";
import { computerFileName, isComputerPath } from "./computer-files.ts";
import { splitAttachments, withAttachments } from "./user-uploads.ts";

describe("paths of files on dot's computer", () => {
  it("takes a path under the home folder as dot's tools name it", () => {
    for (const path of [
      "~/Downloads/Uploads/0b9f4c1e-6a2d-4f8b-9c3e-1d2a3b4c5d6e/photo.png",
      "~/Projects/app/src/server.ts",
      "~/notes with spaces.md",
    ])
      expect(isComputerPath(path)).toBe(true);
    expect(computerFileName("~/Projects/app/src/server.ts")).toBe("server.ts");
  });
  it("refuses anything that could leave the home folder or hide what it is", () => {
    for (const path of [
      "/etc/passwd",
      "Documents/report.md",
      "~",
      "~/",
      "~/../etc/passwd",
      "~/a/../../b",
      "~/a/./b",
      "~/a//b",
      "~/a/",
      "~/a\\b",
      "~/a\u0000b",
      "~/a\nb",
      "~/\ud800",
      `~/${"a".repeat(1023)}`,
    ])
      expect(isComputerPath(path), JSON.stringify(path)).toBe(false);
  });
  it("reads back the files a message names", () => {
    const paths = ["~/Downloads/Uploads/id/a.png", "~/Downloads/Uploads/id/b c.csv"];
    expect(splitAttachments(withAttachments("Look", paths))).toEqual({
      body: "Look",
      files: paths,
    });
  });
});
