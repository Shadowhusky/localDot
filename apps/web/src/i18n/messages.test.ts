// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messagesIn } from "./messages.ts";

describe("finding the messages a file asks for", () => {
  it("reads templates with their values, tr, and a count's pair", () => {
    const source = readFileSync(new URL("./testing/sample-source.txt", import.meta.url), "utf8");
    expect(messagesIn(source)).toEqual([
      "Saved {0} files to {1}",
      "Open {0} now",
      "Line one\nand `two`",
      "close",
      "[button] Reset",
      "Done",
      "item|items",
    ]);
  });
});
