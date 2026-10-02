// A field whose value is a credential (spec "The agent never types credentials"): browserd
// blanks its value in every read, flags it in hit tests, refuses the agent's typing into it, and
// reloads a page that still holds one at hand-back (P8-R12, P8-R14).
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

// attrs: the flat [name, value, name, value…] list DOM.describeNode returns.
export function isSecretField(attrs: readonly string[]): boolean {
  let type = "";
  let autocomplete = "";
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const name = (attrs[i] ?? "").toLowerCase();
    const value = (attrs[i + 1] ?? "").toLowerCase();
    if (name === "type") type = value.trim();
    if (name === "autocomplete") autocomplete = value;
  }
  if (type === "password") return true;
  return autocomplete.split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.has(token));
}
