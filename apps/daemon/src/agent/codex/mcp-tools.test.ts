import { ComputerAction } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { codexTools } from "./mcp-tools.ts";

describe("Codex's computer tool", () => {
  const computer = codexTools().find((tool) => tool.name === "computer");
  const schema = computer?.inputSchema as {
    properties: Record<string, { enum?: string[]; items?: unknown }>;
  };

  it("offers drags along a path, moves, button presses and held keys, with no tuple or union", () => {
    expect(schema.properties.action?.enum).toEqual(
      expect.arrayContaining(["drag", "move", "mouse_down", "mouse_up", "click", "scroll"]),
    );
    expect(schema.properties.path?.items).toMatchObject({
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" } },
    });
    expect(schema.properties.mods).toMatchObject({ type: "array" });
    const text = JSON.stringify(schema);
    for (const shape of ["prefixItems", "anyOf", "oneOf", "allOf"])
      expect(text).not.toContain(shape);
  });

  it("describes every action its schema accepts", () => {
    for (const action of ComputerAction.shape.action.options)
      expect(computer?.description, action).toContain(action);
    for (const field of ["path", "mods", "button"])
      expect(computer?.description, field).toContain(field);
  });
});
