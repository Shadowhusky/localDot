import { keyLikeMatches } from "@localdot/protocol";
import { t } from "../i18n/index.ts";

// The daemon takes 8,000 characters for a message, the names of its files included, and 16 files
// take up to about 2,000 of them. Text past what is left goes with the message as a file, leaving
// the field for what to do with it.
export const LONG_TEXT = 6000;
// The key guard can't read more than 8,000 characters at once: typing stops at this, a little
// short of it, and carries on with the text so far as a file.
export const TEXT_BOUND = 7900;

// A long text's keys come out before it becomes a file. `keyLikeMatches` reads text of any length.
export function withoutKeyLike(text: string): { clean: string; removed: number } {
  let clean = "";
  let from = 0;
  let removed = 0;
  for (const match of keyLikeMatches(text)) {
    clean += text.slice(from, match.start);
    from = match.end;
    removed += 1;
  }
  return { clean: removed ? clean + text.slice(from) : text, removed };
}

// Clipboard pictures come named "image.png" every time.
const CLIPBOARD_NAME = /^(?:image|blob)?(?:\.[a-z0-9]+)?$/i;

const two = (n: number) => String(n).padStart(2, "0");
function stamp(at: Date): string {
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
}

// A name of its own for each pasted picture and text. Downloads never replaces a file, so the time
// keeps names apart across reloads, and a number apart within one second.
function fileNamed(what: string, ext: string, taken: ReadonlySet<string>, at: Date): string {
  const base = `${what} ${stamp(at)}`;
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
    const name = fileNamed("Pasted image", ext, taken, at);
    taken.add(name);
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

export type LongText = "pasted" | "typed";
const LONG_NAMES = { pasted: "Pasted text", typed: "Long message" } as const;

// The chip's name for it, in the words on show; the file keeps its English name for dot.
function longLabel(kind: LongText, count: number): string {
  const n = count.toLocaleString("en-US");
  if (kind === "pasted")
    return count === 1 ? t`Pasted text · ${n} line` : t`Pasted text · ${n} lines`;
  return count === 1 ? t`Long message · ${n} line` : t`Long message · ${n} lines`;
}

const lines = (text: string) => {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
};

// A text too long for a message, as a file of its own and the name its chip goes by. Its file has
// that name too, which tells dot what it is.
export function longTextFile(
  text: string,
  kind: LongText,
  taken: Set<string>,
  at = new Date(),
): { file: File; label: string } {
  const name = fileNamed(LONG_NAMES[kind], "txt", taken, at);
  taken.add(name);
  const count = lines(text);
  return {
    file: new File([text], name, { type: "text/plain" }),
    label: longLabel(kind, count),
  };
}
