import { describe, expect, it } from "vitest";
import { projectBrowser } from "./perception.ts";

const privateName = "private-editable-canary";

function fixture() {
  const strings = [
    "root",
    "#document",
    "DIV",
    "SPAN",
    "BUTTON",
    "contenteditable",
    "true",
    "id",
    "private-label",
    "aria-labelledby",
    "public-label",
    privateName,
  ];
  const snapshot = {
    strings,
    documents: [
      {
        frameId: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          nodeName: [1, 2, 2, 3, 4, 4],
          parentIndex: [-1, 0, 1, 2, 0, 0],
          backendNodeId: [1, 2, 3, 4, 5, 6],
          attributes: [[], [], [7, 8], [5, 6], [], []] as number[][],
          inputValue: { index: [], value: [] },
          textValue: { index: [3], value: [11] },
        },
        layout: {
          nodeIndex: [1, 2, 3, 4, 5],
          bounds: [
            [10, 20, 100, 20],
            [10, 20, 100, 20],
            [10, 20, 100, 20],
            [200, 20, 100, 20],
            [400, 20, 100, 20],
          ],
        },
      },
    ],
  };
  const ax = {
    nodes: [2, 3, 4, 5, 6].map((backendDOMNodeId) => ({
      ignored: false,
      backendDOMNodeId,
      role: {
        value: backendDOMNodeId === 4 ? "textbox" : backendDOMNodeId > 4 ? "button" : "heading",
      },
      name: { value: backendDOMNodeId > 4 ? "Continue" : privateName },
    })),
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
  return { snapshot, ax, project };
}

describe("names derived from masked content", () => {
  it("accepts Chromium's empty attribute value sentinel and still masks contenteditable", () => {
    const { snapshot, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[3] = [5, -1];
    const result = project();
    expect(result.mask.redactions).toHaveLength(1);
    expect(result.targets.some((target) => target.name === "Input field")).toBe(true);
    expect(JSON.stringify(result.targets)).not.toContain(privateName);
  });

  it("does not accept an empty sentinel as an attribute name", () => {
    const { snapshot, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[3] = [-1, 6];
    expect(project).toThrow("metadata");
  });

  it("blanks deep ancestor names and retains unrelated names and generic fields", () => {
    const { project } = fixture();
    const result = project();
    expect(
      result.targets.filter((target) => target.role === "heading").map((target) => target.name),
    ).toEqual(["", ""]);
    expect(result.targets.filter((target) => target.name === "Continue")).toHaveLength(2);
    expect(result.targets.some((target) => target.name === "Input field")).toBe(true);
    expect(JSON.stringify(result.targets)).not.toContain(privateName);
  });

  it("taints referenced labels without tainting unrelated siblings", () => {
    const { snapshot, ax, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[4] = [9, 8];
    ax.nodes[3]!.name.value = privateName;
    const result = project();
    expect(result.targets.filter((target) => target.name === "Continue")).toHaveLength(1);
    expect(JSON.stringify(result.targets)).not.toContain(privateName);
  });

  it("follows transitive name references and terminates cycles", () => {
    const { snapshot, ax, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[4] = [9, 8, 7, 10];
    snapshot.documents[0]!.nodes.attributes[5] = [9, 10];
    snapshot.documents[0]!.nodes.attributes[2] = [9, 10, 7, 8];
    ax.nodes[3]!.name.value = privateName;
    ax.nodes[4]!.name.value = privateName;
    expect(JSON.stringify(project().targets)).not.toContain(privateName);
  });

  it("treats any tainted duplicate label identity as unsafe", () => {
    const { snapshot, ax, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[4] = [7, 8];
    snapshot.documents[0]!.nodes.attributes[5] = [9, 8];
    ax.nodes[4]!.name.value = privateName;
    const result = project();
    expect(result.targets.some((target) => target.name === "Continue")).toBe(true);
    expect(JSON.stringify(result.targets)).not.toContain(privateName);
  });

  it("preserves public names and label references when editable taint is absent", () => {
    const { snapshot, ax, project } = fixture();
    snapshot.documents[0]!.nodes.attributes[3] = [];
    snapshot.documents[0]!.nodes.attributes[4] = [9, 8];
    for (const node of ax.nodes) node.name.value = "Public label";
    expect(project().targets.map((target) => target.name)).toEqual(Array(5).fill("Public label"));
  });
});
