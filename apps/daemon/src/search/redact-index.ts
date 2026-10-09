import { KEY_SCAN_CHARS, scanKeyLike } from "@localdot/protocol";

export const INDEX_REDACTED = "[redacted]";
const LONG_TOKEN = /[A-Za-z0-9_.-]{256,}/g;
const TOKEN_CHAR = /[A-Za-z0-9_.-]/;

function chunk(text: string): string {
  const scan = scanKeyLike(text);
  if (scan.overflow) return INDEX_REDACTED;
  let out = "";
  let at = 0;
  for (const m of scan.matches) {
    out += text.slice(at, m.start) + INDEX_REDACTED;
    at = m.end;
  }
  return out + text.slice(at);
}

// Long tokens go first, so every chunk can end on a non-token character and no key is split.
export function redactForIndex(text: string): string {
  let rest = text.replace(/[]/g, " ").replace(LONG_TOKEN, INDEX_REDACTED);
  let out = "";
  while (rest.length > KEY_SCAN_CHARS) {
    let cut = KEY_SCAN_CHARS;
    while (cut > 0 && TOKEN_CHAR.test(rest[cut - 1] ?? "")) cut--;
    if (cut === 0) cut = KEY_SCAN_CHARS;
    out += chunk(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out + chunk(rest);
}
