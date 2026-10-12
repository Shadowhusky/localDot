// A code typed, pasted or filled in from a text message at cell `at`: a whole code fills every
// cell, a few characters fill from the first empty cell on. Ignore whitespace; strip pasted
// dashes only when they exceed the expected length, preserving literal dashes in access codes.
export function enterCode(
  code: string,
  at: number,
  input: string,
  length: number,
): { code: string; focus: number } {
  const raw = [...input].filter((char) => !/\s/u.test(char));
  const chars = raw.length > length ? raw.filter((char) => !/[\s-]/.test(char)) : raw;
  const now = [...code];
  if (!chars.length) return { code, focus: Math.min(at, now.length, length - 1) };
  if (chars.length >= length) return { code: chars.slice(0, length).join(""), focus: length - 1 };
  const start = Math.min(at, now.length);
  const next = [...now.slice(0, start), ...chars, ...now.slice(start + chars.length)].slice(
    0,
    length,
  );
  return { code: next.join(""), focus: Math.min(start + chars.length, length - 1) };
}

// Backspace at cell `at`: its own character goes, or the one before when it is empty.
export function eraseCode(code: string, at: number): { code: string; focus: number } {
  const now = [...code];
  const gone = at < now.length ? at : now.length - 1;
  if (gone < 0) return { code, focus: 0 };
  now.splice(gone, 1);
  return { code: now.join(""), focus: gone };
}
