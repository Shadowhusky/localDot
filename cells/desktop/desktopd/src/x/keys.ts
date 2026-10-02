const ALIASES: Record<string, string> = {
  ctrl: "Control_L",
  control: "Control_L",
  alt: "Alt_L",
  option: "Alt_L",
  shift: "Shift_L",
  cmd: "Super_L",
  super: "Super_L",
  win: "Super_L",
  meta: "Super_L",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  prior: "Prior",
  next: "Next",
  menu: "Menu",
  print: "Print",
};
const X_NAMES = new Set([...Object.values(ALIASES), "ISO_Level3_Shift"]);

// Normalises a key name from a script or a model onto the X keysym names xhelper.py knows.
export function keyName(name: string): string {
  if (name.length === 1) return /[A-Z]/.test(name) ? name.toLowerCase() : name;
  const lower = name.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return `F${lower.slice(1)}`;
  if (X_NAMES.has(name)) return name;
  throw new RangeError(`unknown key ${JSON.stringify(name)}`);
}
