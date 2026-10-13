import { z } from "zod";
import { codeSeparatorField, privateCodeField, snapshotString } from "./secrets.ts";

const column = z.array(z.number().int()).max(32768);
const snapshot = z.object({
  strings: z.array(snapshotString).max(131072),
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

// Bind the complete segmented code before typing. Never discover the next field by
// following focus: a page could redirect focus to an unrelated, unprotected input.
export function segmentedCodeForm(
  raw: unknown,
  target: number,
  origin: string,
  allowDisabledSubmit = false,
): { fields: number[]; form: number; submit: number } {
  const data = snapshot.parse(raw);
  const nodes = data.documents[0]!.nodes;
  const length = nodes.backendNodeId.length;
  if (
    !length ||
    [nodes.nodeName, nodes.parentIndex, nodes.attributes].some((c) => c.length !== length)
  )
    throw new Error("Invalid code form");
  const string = (i: number | undefined): string => {
    if (i === -1) return "";
    if (i === undefined || i < 0 || data.strings[i] === undefined)
      throw new Error("Invalid code form");
    return data.strings[i];
  };
  const tag = (i: number) => string(nodes.nodeName[i]).toUpperCase();
  const attributes = (i: number) => {
    const pairs = nodes.attributes[i];
    if (!pairs || pairs.length % 2) throw new Error("Invalid code form");
    const attrs = new Map<string, string>();
    for (let p = 0; p < pairs.length; p += 2) {
      const key = string(pairs[p]).toLowerCase();
      if (!key || attrs.has(key)) throw new Error("Invalid code form");
      attrs.set(key, string(pairs[p + 1]));
    }
    return attrs;
  };
  const parentForm = (i: number): number => {
    while (i >= 0) {
      if (tag(i) === "FORM") return i;
      const parent = nodes.parentIndex[i];
      if (parent === undefined || parent >= i || parent < -1) throw new Error("Invalid code form");
      i = parent;
    }
    return -1;
  };
  const targetIndex = nodes.backendNodeId.indexOf(target);
  if (targetIndex < 0) throw new Error("Missing code field");
  const form = parentForm(targetIndex);
  if (form < 0) throw new Error("Missing code form");
  const formAttrs = attributes(form);
  if (
    formAttrs.get("method")?.toLowerCase() !== "post" ||
    new URL(formAttrs.get("action") || "/", origin).origin !== origin ||
    (formAttrs.has("target") && formAttrs.get("target") !== "_self")
  )
    throw new Error("Invalid code form destination");
  const fields: number[] = [];
  const submits: number[] = [];
  for (let i = form + 1; i < length; i++) {
    if (!["INPUT", "BUTTON"].includes(tag(i)) || parentForm(i) !== form) continue;
    const attrs = attributes(i);
    const type = (attrs.get("type") || (tag(i) === "BUTTON" ? "submit" : "text")).toLowerCase();
    if (type === "submit") {
      if (
        ["hidden", "form", "formaction", "formmethod", "formtarget"].some((key) =>
          attrs.has(key),
        ) ||
        (!allowDisabledSubmit && (attrs.has("disabled") || attrs.get("aria-disabled") === "true"))
      )
        throw new Error("Invalid code submit");
      submits.push(nodes.backendNodeId[i]!);
    }
    if (tag(i) !== "INPUT" || !privateCodeField(attrs) || codeSeparatorField(attrs)) continue;
    if (
      attrs.get("maxlength") !== "1" ||
      !["text", "tel", "number"].includes((attrs.get("type") || "text").toLowerCase()) ||
      ["disabled", "readonly", "hidden", "form"].some((key) => attrs.has(key))
    )
      throw new Error("Ambiguous code fields");
    const id = nodes.backendNodeId[i];
    if (!id || id < 0 || fields.includes(id)) throw new Error("Invalid code field");
    fields.push(id);
  }
  if (fields[0] !== target || fields.length < 2 || fields.length > 12)
    throw new Error("Ambiguous code fields");
  if (submits.length !== 1 || !submits[0] || !nodes.backendNodeId[form])
    throw new Error("Ambiguous code submit");
  return { fields, form: nodes.backendNodeId[form], submit: submits[0] };
}

export function segmentedCodeText(text: string, count: number): string {
  // Device codes are commonly shown as ABCD-EFGH; separators have no input box.
  const compact = text.replace(/[\s-]/gu, "");
  if (!/^[a-z0-9]+$/iu.test(compact) || compact.length !== count)
    throw new Error("Code does not match the fields");
  return compact;
}
