import { describe, expect, it } from "vitest";
import { loginForm } from "./login-form.ts";

function fixture(action = "/session", method = "post", label = "Sign in") {
  const strings = [
    "#document",
    "FORM",
    "INPUT",
    "BUTTON",
    "method",
    method,
    "action",
    action,
    "type",
    "password",
    "autocomplete",
    "username",
  ];
  return {
    raw: {
      strings,
      documents: [
        {
          nodes: {
            nodeName: [0, 1, 2, 2, 3],
            backendNodeId: [1, 2, 9, 10, 20],
            parentIndex: [-1, 0, 1, 1, 1],
            attributes: [[], [4, 5, 6, 7], [10, 11], [8, 9], []],
          },
        },
      ],
    },
    ax: { nodes: [{ backendDOMNodeId: 20, name: { value: label } }] },
  };
}
describe("protected sign-in submission", () => {
  it("binds the account and submit control to the password's own form", () => {
    const f = fixture();
    expect(loginForm(f.raw, f.ax, 10, "https://github.com")).toEqual({
      form: 2,
      username: 9,
      submit: 20,
    });
  });
  it.each([
    ["https://evil.example/session", "post", "Sign in"],
    ["/session", "get", "Sign in"],
    ["/delete-account", "post", "Delete account"],
  ])(
    "refuses other destinations, unsafe methods and non-login actions",
    (action, method, label) => {
      const f = fixture(action, method, label);
      expect(() => loginForm(f.raw, f.ax, 10, "https://github.com")).toThrow();
    },
  );
  it("rejects submit controls that override the form destination", () => {
    const f = fixture();
    f.raw.strings.push("formaction", "https://evil.example/");
    const document = f.raw.documents[0];
    if (!document) throw new Error("Missing fixture document");
    document.nodes.attributes[4] = [12, 13];
    expect(() => loginForm(f.raw, f.ax, 10, "https://github.com")).toThrow();
  });
});
