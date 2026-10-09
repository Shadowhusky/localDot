import type { ManualStreamInput } from "@localdot/protocol";

type Mod = "ctrl" | "alt" | "shift" | "super";
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}
// What a key press on the computer view becomes.
export type KeyRoute =
  // A key press on the computer; the browser does nothing with it.
  | { kind: "key"; combo: string[] }
  // A character the browser types into the keyboard field, whose input event carries it on.
  | { kind: "text" }
  // The browser's paste, whose event carries the clipboard's text on.
  | { kind: "paste" }
  // Stays in the browser: a modifier or lock on its own, or a key the computer has no name for.
  | { kind: "local" };

const NAMED: Record<string, string> = {
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Escape: "esc",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "Insert",
  ContextMenu: "Menu",
};
// X's names for the printable ASCII symbols, for shortcuts such as Ctrl+= or Ctrl+Shift+/.
const SYMBOLS: Record<string, string> = {
  " ": "space",
  "!": "exclam",
  '"': "quotedbl",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "&": "ampersand",
  "'": "apostrophe",
  "(": "parenleft",
  ")": "parenright",
  "*": "asterisk",
  "+": "plus",
  ",": "comma",
  "-": "minus",
  ".": "period",
  "/": "slash",
  ":": "colon",
  ";": "semicolon",
  "<": "less",
  "=": "equal",
  ">": "greater",
  "?": "question",
  "@": "at",
  "[": "bracketleft",
  "\\": "backslash",
  "]": "bracketright",
  "^": "asciicircum",
  _: "underscore",
  "`": "grave",
  "{": "braceleft",
  "|": "bar",
  "}": "braceright",
  "~": "asciitilde",
};
const COMPOSING = new Set(["Process", "Dead", "Unidentified"]);

// A Mac's Command does what Control does on the computer (copy, paste, select all, find).
export function modsOf(event: Omit<KeyLike, "key">, apple: boolean): Mod[] {
  const mods: Mod[] = [];
  if (event.ctrlKey || (apple && event.metaKey)) mods.push("ctrl");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");
  if (event.metaKey && !apple) mods.push("super");
  return mods;
}

export function routeKey(event: KeyLike, apple: boolean): KeyRoute {
  if (event.isComposing || event.keyCode === 229 || COMPOSING.has(event.key))
    return { kind: "text" };
  const command = event.ctrlKey || event.metaKey;
  if (
    (command && !event.altKey && event.key.toLowerCase() === "v") ||
    (event.shiftKey && !command && !event.altKey && event.key === "Insert")
  )
    return { kind: "paste" };
  const named = NAMED[event.key] ?? (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key) ? event.key : null);
  if (named) return { kind: "key", combo: [...modsOf(event, apple), named] };
  if ([...event.key].length !== 1) return { kind: "local" };
  // Option or AltGr with a key makes a character (é, @, ™); Alt with a letter is a shortcut.
  const plain = /^[a-z0-9]$/i.test(event.key);
  const shortcut =
    event.metaKey || (event.ctrlKey && (plain || !event.altKey)) || (event.altKey && plain);
  const name = plain ? event.key.toLowerCase() : SYMBOLS[event.key];
  return shortcut && name
    ? { kind: "key", combo: [...modsOf(event, apple), name] }
    : { kind: "text" };
}

// What turns the keyboard field's old text into its new text at its end: characters to delete,
// then text to type. A phone keyboard's corrections and suggestions rewrite the word in place.
export function textEdit(before: string, after: string): { erase: number; text: string } {
  const old = [...before],
    now = [...after];
  let same = 0;
  while (same < old.length && same < now.length && old[same] === now[same]) same++;
  return { erase: old.length - same, text: now.slice(same).join("") };
}

// Text as stream inputs no larger than one typing call takes, with every line ending a Return.
export function textInputs(text: string, limit = 4000): ManualStreamInput[] {
  const chars = [...text.replace(/\r\n?/g, "\n")],
    out: ManualStreamInput[] = [];
  for (let i = 0; i < chars.length; i += limit)
    out.push({ kind: "text", text: chars.slice(i, i + limit).join("") });
  return out;
}

export const isApple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
