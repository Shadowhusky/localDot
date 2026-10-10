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
  const passwordIndex = nodes.backendNodeId.indexOf(password);
  if (passwordIndex < 0) throw new Error("No password field");
  const currentPassword = /(?:^|\s)current-password(?:\s|$)/iu.test(
    attrs(passwordIndex).get("autocomplete") ?? "",
  );
  const form = parentForm(passwordIndex);
  // JavaScript sign-ins can have no FORM. Require the standard current-password marker,
  // one password on the document, and a clearly named sign-in/continue button below.
  if (form < 0 && !currentPassword) throw new Error("No sign-in form");
  const formAttrs = form < 0 ? new Map<string, string>() : attrs(form);
  const method = formAttrs.get("method")?.toLowerCase();
  if (
    (method !== undefined && method !== "post") ||
    (method === undefined && !currentPassword) ||
    new URL(formAttrs.get("action") || "/", origin).origin !== origin ||
    (formAttrs.has("target") && formAttrs.get("target") !== "_self")
  )
    throw new Error("No same-site sign-in form");
  const labels = new Map(
    tree.parse(ax).nodes.map((node) => [node.backendDOMNodeId, node.name?.value ?? ""]),
  );
  const usernames: number[] = [],
    submits: number[] = [];
  let passwords = 0;
  for (let i = form + 1; i < length; i++) {
    if (!["INPUT", "BUTTON"].includes(tag(i)) || parentForm(i) !== form) continue;
    const a = attrs(i),
      id = nodes.backendNodeId[i];
    if (id === undefined || a.has("hidden") || a.has("form")) continue;
    if (a.get("type")?.toLowerCase() === "password") passwords++;
    if (a.has("readonly")) continue;
    const type = (a.get("type") || (tag(i) === "BUTTON" ? "submit" : "text")).toLowerCase();
    if (
      ["text", "email"].includes(type) &&
      !a.has("disabled") &&
      (type === "email" ||
        /user|email|login|account/iu.test(
          [a.get("autocomplete"), a.get("id"), a.get("name"), a.get("aria-label")].join(" "),
        ))
    )
      usernames.push(id);
    const label = (a.get("value") || labels.get(id) || "").trim();
    if (/delete|remove|purchase|pay|reset|change password|删除|付款|重置/iu.test(label))
      throw new Error("Not a sign-in action");
    const signIn =
      /^(?:sign\s*in|log\s*in|login|log\s*on|se connecter|connexion|anmelden|iniciar sesi[oó]n|登录|登入)$/iu.test(
        label,
      );
    const next =
      currentPassword &&
      /^(?:next|continue|下一步|继续|繼續|suivant|continuer|weiter|continuar)$/iu.test(label);
    if (
      (type === "submit" || (tag(i) === "BUTTON" && type === "button")) &&
      // A form with the default GET method must use an explicit JS button, so the
      // private password can never be put into the address bar by native submission.
      (method === "post" || (tag(i) === "BUTTON" && type === "button")) &&
      (allowDisabledSubmit || !a.has("disabled")) &&
      (signIn || next) &&
      !a.has("formaction") &&
      !a.has("formmethod") &&
      !a.has("formtarget")
    )
      submits.push(id);
  }
  const submit = submits[0],
    formId = form < 0 ? nodes.backendNodeId[0] : nodes.backendNodeId[form];
  if (
    passwords !== 1 ||
    submits.length !== 1 ||
    usernames.length > 1 ||
    submit === undefined ||
    formId === undefined
  )
    throw new Error("Ambiguous sign-in form");
  return {
    ...(usernames[0] === undefined ? {} : { username: usernames[0] }),
    submit,
    form: formId,
  };
}
