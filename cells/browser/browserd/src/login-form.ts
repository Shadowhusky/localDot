import { z } from "zod";

const column = z.array(z.number().int()).max(32768);
const snapshot = z.object({
  strings: z.array(z.string()).max(131072),
  documents: z
    .array(
      z.object({
        nodes: z.object({
          nodeName: column,
          backendNodeId: column,
          parentIndex: column,
          attributes: z.array(column).max(32768),
        }),
      }),
    )
    .min(1)
    .max(256),
});
const tree = z.object({
  nodes: z
    .array(
      z.object({
        backendDOMNodeId: z.number().optional(),
        name: z.object({ value: z.string() }).optional(),
      }),
    )
    .max(32768),
});

// A password answer may submit only an unambiguous sign-in form on the bound site.
// Password changes, account deletion confirmations, OTPs and cross-origin forms do not qualify.
export function loginForm(
  raw: unknown,
  ax: unknown,
  password: number,
  origin: string,
  allowDisabledSubmit = false,
): { username?: number; submit: number; form: number } {
  const data = snapshot.parse(raw),
    nodes = data.documents[0]?.nodes;
  if (!nodes) throw new Error("Invalid sign-in form");
  const length = nodes.backendNodeId.length;
  if (
    nodes.nodeName.length !== length ||
    nodes.parentIndex.length !== length ||
    nodes.attributes.length !== length
  )
    throw new Error("Invalid sign-in form");
  const string = (i: number | undefined) => {
    // DOMSnapshot uses -1 for an empty attribute value (autofocus, disabled, etc.).
    if (i === -1) return "";
    if (i === undefined || i < 0 || data.strings[i] === undefined)
      throw new Error("Invalid sign-in form");
    return data.strings[i];
  };
  const attrs = (i: number) => {
    const pairs = nodes.attributes[i];
    if (!pairs || pairs.length % 2) throw new Error("Invalid sign-in form");
    const result = new Map<string, string>();
    for (let p = 0; p < pairs.length; p += 2)
      result.set(string(pairs[p]).toLowerCase(), string(pairs[p + 1]));
    return result;
  };
  const tag = (i: number) => string(nodes.nodeName[i]).toUpperCase();
  const parentForm = (i: number) => {
    for (let count = 0; i >= 0 && count < length; count++) {
      if (tag(i) === "FORM") return i;
      const parent = nodes.parentIndex[i];
      if (parent === undefined || parent >= i) throw new Error("Invalid sign-in form");
      i = parent;
    }
    return -1;
  };
  const passwordIndex = nodes.backendNodeId.indexOf(password),
    form = parentForm(passwordIndex);
  if (passwordIndex < 0 || form < 0) throw new Error("No sign-in form");
  const formAttrs = attrs(form);
  if (
    formAttrs.get("method")?.toLowerCase() !== "post" ||
    new URL(formAttrs.get("action") || "/", origin).origin !== origin ||
    (formAttrs.has("target") && formAttrs.get("target") !== "_self")
  )
    throw new Error("No same-site sign-in form");
  const labels = new Map(
    tree.parse(ax).nodes.map((node) => [node.backendDOMNodeId, node.name?.value ?? ""]),
  );
  const usernames: number[] = [],
    submits: number[] = [];
  for (let i = form + 1; i < length; i++) {
    if (!["INPUT", "BUTTON"].includes(tag(i)) || parentForm(i) !== form) continue;
    const a = attrs(i),
      id = nodes.backendNodeId[i];
    if (id === undefined || a.has("readonly") || a.has("hidden") || a.has("form")) continue;
    const type = (a.get("type") || (tag(i) === "BUTTON" ? "submit" : "text")).toLowerCase();
    if (
      ["text", "email"].includes(type) &&
      !a.has("disabled") &&
      /user|email|login|account/iu.test(
        [a.get("autocomplete"), a.get("id"), a.get("name"), a.get("aria-label")].join(" "),
      )
    )
      usernames.push(id);
    const label = a.get("value") || labels.get(id) || "";
    if (
      type === "submit" &&
      (allowDisabledSubmit || !a.has("disabled")) &&
      /^(?:sign\s*in|log\s*in)$/iu.test(label.trim()) &&
      !a.has("formaction") &&
      !a.has("formmethod") &&
      !a.has("formtarget")
    )
      submits.push(id);
  }
  const submit = submits[0],
    formId = nodes.backendNodeId[form];
  if (submits.length !== 1 || usernames.length > 1 || submit === undefined || formId === undefined)
    throw new Error("Ambiguous sign-in form");
  return {
    ...(usernames[0] === undefined ? {} : { username: usernames[0] }),
    submit,
    form: formId,
  };
}
