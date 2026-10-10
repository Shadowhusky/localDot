import { expect, it } from "vitest";
import { projectBrowser } from "./perception.ts";

function fixture({ explicit = false, duplicate = false, role = "radio" } = {}) {
  const strings = ["root", "#document", "LABEL", "SPAN", "INPUT", "id", "choice", "for"];
  const snapshot = {
    strings,
    documents: [
      {
        frameId: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          inputValue: { index: [], value: [] },
          textValue: { index: [], value: [] },
          nodeName: [1, 2, 3, 4, 4],
          parentIndex: [-1, 0, 1, explicit ? 0 : 1, 0],
          backendNodeId: [1, 2, 3, 4, 5],
          attributes: [[], explicit ? [7, 6] : [], [], [5, 6], duplicate ? [5, 6] : []],
        },
        layout: {
          nodeIndex: [1, 2, 3, 4],
          bounds: [
            [100, 100, 80, 80],
            [120, 120, 40, 40],
            [100, 100, 1, 1],
            [200, 100, 1, 1],
          ],
        },
      },
    ],
  };
  const ax = {
    nodes: [
      { ignored: false, backendDOMNodeId: 4, role: { value: role }, name: { value: "Choice" } },
    ],
  };
  const project = () =>
    projectBrowser(
      snapshot,
      ax,
      "root",
      {
        document: { tabId: "tab", revision: 1, frame: false },
        content: [0, 0, 1280, 800],
        width: 1280,
        height: 800,
        factor: 1,
        scrollX: 0,
        scrollY: 0,
        focus: "page",
      },
      1,
    );
  return { snapshot, ax, project };
}

it.each([false, true])(
  "identifies a visible label around a tiny input (explicit=%s)",
  (explicit) => {
    const { project } = fixture({ explicit });
    const target = project().targetForNode(3);
    expect(target).toMatchObject({
      source: "ax",
      role: "radio",
      bbox: { x: 100, y: 100, w: 80, h: 80 },
    });
    expect(project().targetOf(4)?.bbox?.w).toBe(1);
  },
);
it("handles checkbox labels and refuses ambiguous ids", () => {
  expect(fixture({ explicit: true, role: "checkbox" }).project().targetForNode(3)?.role).toBe(
    "checkbox",
  );
  expect(fixture({ explicit: true, duplicate: true }).project().targetForNode(3)).toBeNull();
});
it("does not infer a control for an unrelated or changed label", () => {
  const f = fixture({ explicit: true });
  f.snapshot.strings.push("missing");
  const root = f.snapshot.documents[0];
  if (!root) throw new Error("missing fixture");
  root.nodes.attributes[1] = [7, 8];
  expect(f.project().targetForNode(3)).toBeNull();
  expect(fixture({ role: "textbox" }).project().targetForNode(3)).toBeNull();
});
it("a real nested button retains its own action instead of inheriting the label", () => {
  const f = fixture();
  f.ax.nodes.push({
    ignored: false,
    backendDOMNodeId: 3,
    role: { value: "button" },
    name: { value: "Delete" },
  });
  expect(f.project().targetForNode(3)).toMatchObject({ role: "button", name: "Delete" });
});
