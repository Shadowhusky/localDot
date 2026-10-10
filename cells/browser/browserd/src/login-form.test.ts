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
  it("accepts Chromium's empty-value sentinel on a rejected form's autofocus field", () => {
    const f = fixture();
    f.raw.strings.push("autofocus");
    const document = f.raw.documents[0];
    if (!document) throw new Error("Missing fixture document");
    document.nodes.attributes[2] = [10, 11, 12, -1];
    expect(loginForm(f.raw, f.ax, 10, "https://github.com")).toEqual({
      form: 2,
      username: 9,
      submit: 20,
    });
  });
  it("recognizes a retry form with disabled submit but refuses submission until enabled", () => {
    const f = fixture();
    f.raw.strings.push("disabled", "");
    const document = f.raw.documents[0];
    if (!document) throw new Error("Missing fixture document");
    document.nodes.attributes[4] = [12, -1];
    expect(() => loginForm(f.raw, f.ax, 10, "https://github.com")).toThrow();
    expect(loginForm(f.raw, f.ax, 10, "https://github.com", true).submit).toBe(20);
    document.nodes.attributes[4] = [];
    expect(loginForm(f.raw, f.ax, 10, "https://github.com").submit).toBe(20);
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
  it.each(["https://accounts.example.net", "https://work.example.org", "https://shop.example.com"])(
    "recognizes a standard current-password step on %s without site-specific rules",
    (origin) => {
      const f = fixture("/auth", "post", "Continue");
      f.raw.strings.push("current-password");
      f.raw.documents[0]!.nodes.attributes[3]!.push(10, 12);
      expect(loginForm(f.raw, f.ax, 10, origin).submit).toBe(20);
    },
  );
  it.each(["登录", "登入", "Se connecter", "Anmelden", "Iniciar sesión"])(
    "recognizes sign-in button %s",
    (label) => {
      const f = fixture("/session", "post", label);
      expect(loginForm(f.raw, f.ax, 10, "https://portal.example.org").submit).toBe(20);
    },
  );
  it("recognizes a JavaScript password step without a FORM, but rejects its native GET submit", () => {
    const f = fixture("/", "post", "Next");
    f.raw.strings.push("DIV", "current-password", "button");
    const n = f.raw.documents[0]!.nodes;
    n.nodeName[1] = 12;
    n.attributes[1] = [];
    n.attributes[3]!.push(10, 13);
    n.attributes[4] = [8, 14];
    expect(loginForm(f.raw, f.ax, 10, "https://identity.example.org")).toEqual({
      form: 1,
      username: 9,
      submit: 20,
    });
    n.attributes[4] = [];
    expect(() => loginForm(f.raw, f.ax, 10, "https://identity.example.org")).toThrow();
  });
  it("rejects password-change or registration forms even when their button says Continue", () => {
    const f = fixture("/session", "post", "Continue");
    f.raw.strings.push("current-password");
    const n = f.raw.documents[0]!.nodes;
    n.attributes[3]!.push(10, 12);
    n.nodeName.push(2);
    n.backendNodeId.push(30);
    n.parentIndex.push(1);
    n.attributes.push([8, 9]);
    expect(() => loginForm(f.raw, f.ax, 10, "https://identity.example.org")).toThrow();
  });
});
