import { KEYSYM_TABLE } from "./keysyms.ts";

// Names models and scripts use that X does not: xdotool's modifiers, DOM key names and
// shorthands. `meta` is the Super key, as on the keyboards these names come from.
const ALIASES: Record<string, string> = {
  ctrl: "Control_L",
  control: "Control_L",
  alt: "Alt_L",
  option: "Alt_L",
  altgr: "ISO_Level3_Shift",
  shift: "Shift_L",
  cmd: "Super_L",
  command: "Super_L",
  super: "Super_L",
  win: "Super_L",
  windows: "Super_L",
  meta: "Super_L",
  hyper: "Hyper_L",
  enter: "Return",
  esc: "Escape",
  backspace: "BackSpace",
  del: "Delete",
  ins: "Insert",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  pageup: "Prior",
  pagedown: "Next",
  pgup: "Prior",
  pgdn: "Next",
  capslock: "Caps_Lock",
  numlock: "Num_Lock",
  scrolllock: "Scroll_Lock",
  printscreen: "Print",
  prtsc: "Print",
  contextmenu: "Menu",
  volumeup: "XF86AudioRaiseVolume",
  volumedown: "XF86AudioLowerVolume",
  mute: "XF86AudioMute",
  audiovolumeup: "XF86AudioRaiseVolume",
  audiovolumedown: "XF86AudioLowerVolume",
  audiovolumemute: "XF86AudioMute",
  mediaplaypause: "XF86AudioPlay",
  mediatracknext: "XF86AudioNext",
  mediatrackprevious: "XF86AudioPrev",
};

interface Keysyms {
  value: Map<string, number>;
  // A value's first name, the one X itself prints; later names are deprecated aliases.
  primary: Map<number, string>;
  folded: Map<string, string[]>;
}

let keysyms: Keysyms | undefined;
function table(): Keysyms {
  if (keysyms) return keysyms;
  const words = KEYSYM_TABLE.split(/\s+/).filter(Boolean);
  const value = new Map<string, number>();
  const primary = new Map<number, string>();
  const folded = new Map<string, string[]>();
  for (let i = 0; i + 1 < words.length; i += 2) {
    const name = words[i] as string;
    const sym = Number.parseInt(words[i + 1] as string, 16);
    value.set(name, sym);
    if (!primary.has(sym)) primary.set(sym, name);
    const lower = name.toLowerCase();
    folded.set(lower, [...(folded.get(lower) ?? []), name]);
  }
  keysyms = { value, primary, folded };
  return keysyms;
}

export class UnknownKeyError extends RangeError {
  constructor(
    readonly key: string,
    readonly suggestions: string[],
  ) {
    super(
      `unknown key ${JSON.stringify(key.slice(0, 40))}${suggestions.length ? `; did you mean ${suggestions.join(", ")}?` : ""}`,
    );
    this.name = "UnknownKeyError";
  }
}

const single = (name: string) => [...name].length === 1;

// A key name from a model or a script as the X keysym name xhelper presses: aliases and any X
// name in any letter case. A single character stays itself, with A-Z lower-cased, so that
// "ctrl+S" is Ctrl+S rather than Ctrl+Shift+S.
export function keyName(name: string): string {
  if (single(name)) return /[A-Z]/.test(name) ? name.toLowerCase() : name;
  const lower = name.toLowerCase();
  const { value, primary, folded } = table();
  const found =
    (Object.hasOwn(ALIASES, lower) ? ALIASES[lower] : undefined) ??
    (value.has(name) ? name : undefined) ??
    preferUnshifted(folded.get(lower));
  if (found === undefined) throw new UnknownKeyError(name, closeKeys(name));
  return primary.get(value.get(found) as number) ?? found;
}

// Of names that differ only in case (Aacute, aacute), the lower-case one: the key's own level.
function preferUnshifted(names: string[] | undefined): string | undefined {
  if (!names?.length) return undefined;
  return (
    names.find((n) => n === n.toLowerCase()) ?? names.find((n) => /^[a-z]/.test(n)) ?? names[0]
  );
}

// The keysym xhelper presses for a name keyName returned (xhelper.py keysym_for_char for a
// character).
export function keysymOf(name: string): number {
  if (single(name)) {
    if (name === "\n") return 0xff0d;
    if (name === "\t") return 0xff09;
    const cp = name.codePointAt(0) as number;
    return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x1000000 | cp;
  }
  const sym = table().value.get(name);
  if (sym === undefined) throw new UnknownKeyError(name, closeKeys(name));
  return sym;
}

// Modifiers and locks: X does not repeat them while they are held down.
const UNREPEATED = new Set([
  "Shift_L",
  "Shift_R",
  "Control_L",
  "Control_R",
  "Alt_L",
  "Alt_R",
  "Meta_L",
  "Meta_R",
  "Super_L",
  "Super_R",
  "Hyper_L",
  "Hyper_R",
  "ISO_Level3_Shift",
  "ISO_Level5_Shift",
  "Mode_switch",
  "Caps_Lock",
  "Shift_Lock",
  "Num_Lock",
]);

// Whether holding the combo down types it again and again: any key but a modifier repeats.
export function repeatsWhileHeld(combo: readonly string[]): boolean {
  return combo.some((key) => {
    try {
      return !UNREPEATED.has(keyName(key));
    } catch {
      return true;
    }
  });
}

// Every name of a combo resolves, or the first that does not names its close matches.
export function checkCombo(combo: readonly string[]): string | undefined {
  for (const key of combo) {
    try {
      keyName(key);
    } catch (error) {
      if (error instanceof UnknownKeyError) return error.message;
      throw error;
    }
  }
  return undefined;
}

const squash = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "");

// Up to three names close to an unknown one: the same letters without case and separators, a
// shared prefix, or a few edits away, nearest first and one name per key.
export function closeKeys(name: string, limit = 3): string[] {
  const wanted = squash(name);
  if (!wanted) return [];
  const { value } = table();
  const near = Math.max(1, Math.floor(wanted.length / 3));
  const scored: { name: string; sym: number; score: number }[] = [];
  const consider = (candidate: string, sym: number | undefined) => {
    if (sym === undefined || single(candidate)) return;
    const other = squash(candidate);
    const distance = editDistance(wanted, other, near + 1);
    const prefix =
      Math.min(wanted.length, other.length) >= 3 &&
      (other.startsWith(wanted) || wanted.startsWith(other));
    if (distance <= near) scored.push({ name: candidate, sym, score: distance });
    else if (prefix) scored.push({ name: candidate, sym, score: near + 0.5 });
  };
  for (const [alias, canonical] of Object.entries(ALIASES)) consider(alias, value.get(canonical));
  for (const [candidate, sym] of value) consider(candidate, sym);
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  const seen = new Set<number>();
  const out: string[] = [];
  for (const s of scored) {
    if (seen.has(s.sym)) continue;
    seen.add(s.sym);
    out.push(s.name);
    if (out.length === limit) break;
  }
  return out;
}

// Edit distance counting a swap of neighbours as one edit (shfit, Retrun), giving up (returning
// cap + 1) once every path is longer than `cap`.
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const above = rows[i - 1] as number[];
      let d = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > cap) return cap + 1;
    rows.push(row);
  }
  return (rows[a.length] as number[])[b.length] as number;
}
