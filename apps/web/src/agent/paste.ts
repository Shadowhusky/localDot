import { KEY_SCAN_CHARS, keyLikePresent } from "@localdot/protocol";

// Text past this length is a document rather than a message: it goes with the message as a file,
// leaving the field for what to do with it.
export const LONG_PASTE = 4000;

// The key scanner reads at most KEY_SCAN_CHARS at once, so a longer text is read in windows that
// overlap by more than any key's length. Past PASTE_SCAN_CHARS it counts as holding one.
const PASTE_SCAN_CHARS = 1024 * 1024;
const OVERLAP = 512;
function holdsKey(text: string): boolean {
  if (text.length > PASTE_SCAN_CHARS) return true;
  for (let at = 0; at < text.length; at += KEY_SCAN_CHARS - OVERLAP)
    if (keyLikePresent(text.slice(at, at + KEY_SCAN_CHARS))) return true;
  return false;
}

// Clipboard pictures come named "image.png" every time.
const CLIPBOARD_NAME = /^(?:image|blob)?(?:\.[a-z0-9]+)?$/i;

const two = (n: number) => String(n).padStart(2, "0");
function stamp(at: Date): string {
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
}

// A name of its own for each pasted picture and text. Downloads never replaces a file, so the time
// keeps names apart across reloads, and a number apart within one second.
export function pastedName(
  kind: "image" | "text",
  ext: string,
  taken: ReadonlySet<string>,
  at = new Date(),
): string {
  const base = `Pasted ${kind} ${stamp(at)}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base} ${n}.${ext}`;
    if (!taken.has(name)) return name;
  }
}

export function pastedFiles(files: readonly File[], taken: Set<string>, at = new Date()): File[] {
  return files.map((file) => {
    if (!file.type.startsWith("image/") || !CLIPBOARD_NAME.test(file.name)) return file;
    const ext = (file.type
      .slice("image/".length)
      .replace("jpeg", "jpg")
      .match(/^[a-z0-9]+/) ?? ["png"])[0];
    const name = pastedName("image", ext, taken, at);
    taken.add(name);
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

// A long text the key guard has nothing to say about becomes a text file.
export function pastedText(text: string, taken: Set<string>, at = new Date()): File | null {
  if (text.length <= LONG_PASTE || holdsKey(text)) return null;
  const name = pastedName("text", "txt", taken, at);
  taken.add(name);
  return new File([text], name, { type: "text/plain" });
}
