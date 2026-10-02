// Key combinations browserd will not press for the agent (P8-R7): each opens DevTools or the page's
// source, where cookies, storage and script values are on screen. The managed policy blocks
// devtools:// and view-source: too; this keeps the agent from even asking.
const REFUSED: readonly (readonly string[])[] = [
  ["f12"],
  ["ctrl", "shift", "i"],
  ["ctrl", "shift", "j"],
  ["ctrl", "shift", "c"],
  ["ctrl", "shift", "k"],
  ["ctrl", "u"],
  ["alt", "ctrl", "i"],
];

const ALIASES: Record<string, string> = {
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  shift_l: "shift",
  shift_r: "shift",
  alt_l: "alt",
  alt_r: "alt",
  meta: "alt",
  meta_l: "alt",
  meta_r: "alt",
};

function canonical(key: string): string {
  const k = key.trim().toLowerCase();
  return ALIASES[k] ?? k;
}

export function refusedShortcut(combo: readonly string[]): boolean {
  const keys = new Set(combo.map(canonical));
  return REFUSED.some((r) => r.length === keys.size && r.every((k) => keys.has(k)));
}
