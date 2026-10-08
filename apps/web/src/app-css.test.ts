import { describe, expect, it } from "vitest";
import { readSource } from "./testing/read-source.ts";

const app = await readSource(new URL("./app.css", import.meta.url));

describe("app.css", () => {
  it("lets a long caption wrap anywhere instead of spilling out of the stage column", () => {
    const caption = /\.caption\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(caption).toMatch(/overflow-wrap:\s*anywhere;/);
  });
});
