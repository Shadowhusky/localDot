import { describe, expect, it } from "vitest";
import { projectBrowser } from "./perception.ts";

const canary = "private-editable-canary";
function fixture() {
  const strings: string[] = [];
  const at = (value: string) => {
    let index = strings.indexOf(value);
    if (index === -1) index = strings.push(value) - 1;
    return index;
  };
  const names = ["#document", "BUTTON", "BUTTON", "H2", "SPAN", "BUTTON"];
  const attributes: number[][] = names.map(() => []);
  const parents = [-1, 0, 0, 0, 3, 0];
  const snapshot = {
    strings,
    documents: [
      {
        frameId: at("root"),
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          nodeName: names.map(at),
          parentIndex: parents,
          backendNodeId: names.map((_, index) => index + 1),
          attributes,
          inputValue: { index: [], value: [] },
          textValue: { index: [4], value: [at(canary)] },
        },
        layout: {
          nodeIndex: [1, 2, 3, 4, 5],
          bounds: names.slice(1).map((_, index) => [10 + index * 80, 20, 60, 30]),
        },
      },
    ],
  };
  const ax = {
    nodes: names.slice(1).map((_, index) => ({
      ignored: false,
      backendDOMNodeId: index + 2,
      role: { value: index === 2 ? "heading" : index === 3 ? "textbox" : "button" },
      name: { value: index === 4 ? "Continue" : canary },
    })),
  };
  const set = (node: number, pairs: Record<string, string>) => {
    attributes[node] = Object.entries(pairs).flatMap(([key, value]) => [at(key), at(value)]);
  };
  const project = () =>
    projectBrowser(
      snapshot,
      ax,
      "root",
      {
        document: { tabId: "tab", revision: 1, frame: false },
        content: [0, 100, 1280, 700],
        width: 1280,
        height: 700,
        factor: 1,
        scrollX: 0,
        scrollY: 0,
        focus: "page",
      },
      1,
    );
  return { snapshot, ax, attributes, at, set, project };
}

describe("scoped editable-name dependency boundary", () => {
  it("P1 public reference cycles remain available with no editable source", () => {
    const f = fixture();
    f.set(1, { id: "a", "aria-labelledby": "b" });
    f.set(2, { id: "b", "aria-labelledby": "a" });
    for (const n of f.ax.nodes) n.name.value = "Public label";
    expect(f.project().targets.map((n) => n.name)).toEqual(Array(5).fill("Public label"));
  });
  it("B1 earlier consumers and transitive reserved-looking IDs cannot outpace later editable taint", () => {
    const f = fixture();
    f.set(1, { "aria-labelledby": "bridge" });
    f.set(2, { id: "bridge", "aria-labelledby": "__proto__" });
    f.set(3, { id: "__proto__" });
    f.set(4, { contenteditable: "" });
    const p = f.project();
    expect(p.targets.map((n) => n.name)).toEqual(["", "", "", "Input field", "Continue"]);
    expect(JSON.stringify(p.targets)).not.toContain(canary);
    expect(p.mask.redactions).toHaveLength(1);
  });
  it("B2 duplicate IDs are conservative regardless of which member is visited first", () => {
    const f = fixture();
    f.set(1, { id: "same" });
    f.set(2, { "aria-labelledby": "same" });
    f.set(3, { id: "same" });
    f.set(4, { contenteditable: "true" });
    f.ax.nodes[0]!.name.value = "Public duplicate";
    const p = f.project();
    expect(p.targets.map((n) => n.name)).toEqual([
      "Public duplicate",
      "",
      "",
      "Input field",
      "Continue",
    ]);
  });
  it("B3 total references are bounded even when dependency edges deduplicate", () => {
    const f = fixture();
    f.set(3, { id: "x" });
    f.set(1, { "aria-labelledby": Array(16_384).fill("x").join(" ") });
    f.set(2, { "aria-labelledby": Array(16_384).fill("x").join(" ") });
    expect(f.project().targets).toHaveLength(5);
    f.set(2, { "aria-labelledby": Array(16_385).fill("x").join(" ") });
    expect(f.project).toThrow("metadata");
  });
  it("B4 duplicate-ID fanout has an independent work limit", () => {
    const f = fixture();
    const root = f.snapshot.documents[0]!;
    for (let index = 0; index < 200; index++) {
      root.nodes.nodeName.push(f.at("DIV"));
      root.nodes.parentIndex.push(0);
      root.nodes.backendNodeId.push(root.nodes.backendNodeId.length + 1);
      root.nodes.attributes.push([f.at("id"), f.at("fanout")]);
    }
    f.set(1, { "aria-labelledby": Array(200).fill("fanout").join(" ") });
    expect(f.project().targets).toHaveLength(5);
    f.set(1, { "aria-labelledby": Array(400).fill("fanout").join(" ") });
    expect(f.project).toThrow("metadata");
  });
  it("B5 empty-value sentinel keeps masking but never becomes an empty key or invalid index", () => {
    const f = fixture();
    f.attributes[4] = [f.at("contenteditable"), -1];
    expect(f.project().mask.redactions).toHaveLength(1);
    expect(f.project().targets.find((n) => n.role === "textbox")?.name).toBe("Input field");
    for (const pair of [
      [-1, -1],
      [f.at("contenteditable"), -2],
      [f.at("contenteditable"), 131071],
    ]) {
      f.attributes[4] = pair;
      expect(f.project).toThrow("metadata");
    }
  });
});
