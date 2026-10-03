// Incremental output decoding happens before the bounded raw projection can lose an escape
// prefix. Stdout/stderr each own their control state; nothing here executes terminal commands.
export const TERMINAL_LIMITS = Object.freeze({
  bytes: 65_536,
  inputBytes: 4 * 1024 * 1024,
  lines: 2000,
});
type Mode =
  | "text"
  | "escape"
  | "intermediate"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";
export interface TerminalLane {
  readonly parts: readonly { readonly text: string; readonly bytes: number }[];
  readonly bytes: number;
  readonly mode: Mode;
  readonly high: string;
  readonly afterCR: boolean;
}
export interface TerminalText {
  readonly stdout: TerminalLane;
  readonly stderr: TerminalLane;
  readonly inputBytes: number;
  readonly truncated: boolean;
  readonly controlsRemoved: boolean;
  readonly nonprintable: boolean;
}
const lane = (): TerminalLane => ({ parts: [], bytes: 0, mode: "text", high: "", afterCR: false });
export const emptyTerminal = (): TerminalText => ({
  stdout: lane(),
  stderr: lane(),
  inputBytes: 0,
  truncated: false,
  controlsRemoved: false,
  nonprintable: false,
});
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function codeBytes(char: string): number {
  const n = char.codePointAt(0) ?? 0;
  return n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
}
function retain(
  input: TerminalLane,
  text: string,
): Pick<TerminalLane, "parts" | "bytes"> & { clipped: boolean } {
  const parts = [...input.parts];
  let bytes = input.bytes;
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + 1024);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    )
      end--;
    const value = text.slice(i, end),
      size = utf8Bytes(value),
      last = parts.at(-1);
    if (last && last.text.length + value.length <= 1024)
      parts[parts.length - 1] = { text: last.text + value, bytes: last.bytes + size };
    else parts.push({ text: value, bytes: size });
    bytes += size;
    i = end;
  }
  const limit = TERMINAL_LIMITS.bytes / 2,
    clipped = bytes > limit;
  while (bytes > limit && parts.length) {
    const first = parts[0];
    if (!first) break;
    if (first.bytes <= bytes - limit) {
      bytes -= first.bytes;
      parts.shift();
      continue;
    }
    let removed = 0,
      position = 0;
    while (removed < bytes - limit && position < first.text.length) {
      const char = String.fromCodePoint(first.text.codePointAt(position) ?? 0);
      position += char.length;
      removed += codeBytes(char);
    }
    parts[0] = { text: first.text.slice(position), bytes: first.bytes - removed };
    bytes -= removed;
  }
  return { parts, bytes, clipped };
}
export function terminalDisplayed(
  text: TerminalText,
  stream: "stdout" | "stderr",
): { text: string; truncated: boolean } {
  const content = text[stream].parts.map((part) => part.text).join("");
  const lines = content.split("\n"),
    shortened = lines.length > TERMINAL_LIMITS.lines / 2;
  return {
    text: shortened ? lines.slice(-TERMINAL_LIMITS.lines / 2).join("\n") : content,
    truncated: text.truncated || shortened,
  };
}
export function appendTerminal(
  previous: TerminalText,
  stream: "stdout" | "stderr",
  chunk: string,
): TerminalText {
  if (previous.inputBytes >= TERMINAL_LIMITS.inputBytes) return { ...previous, truncated: true };
  const input = previous[stream];
  let mode = input.mode,
    high = input.high,
    afterCR = input.afterCR;
  let controlsRemoved = previous.controlsRemoved,
    nonprintable = previous.nonprintable;
  let inputBytes = previous.inputBytes,
    truncated = previous.truncated;
  const output: string[] = [];
  const emit = (char: string) => {
    if (char === "\r") {
      output.push("\n");
      afterCR = true;
      return;
    }
    if (char === "\n" && afterCR) {
      afterCR = false;
      return;
    }
    afterCR = false;
    const n = char.codePointAt(0) ?? 0;
    if (char === "\n" || char === "\t" || (n >= 0x20 && n !== 0x7f && !(n >= 0x80 && n <= 0x9f)))
      output.push(char);
    else {
      controlsRemoved = true;
      if (n === 0 || n === 8 || n === 0x7f) nonprintable = true;
    }
  };
  const consume = (char: string) => {
    const n = char.codePointAt(0) ?? 0;
    if (mode === "osc" || mode === "string") {
      if (n === 0x9c || (mode === "osc" && n === 7)) mode = "text";
      else if (n === 0x1b) mode = mode === "osc" ? "osc-escape" : "string-escape";
      return;
    }
    if (mode === "osc-escape" || mode === "string-escape") {
      if (char === "\\" || n === 0x9c || (mode === "osc-escape" && n === 7)) mode = "text";
      else if (n !== 0x1b) mode = mode === "osc-escape" ? "osc" : "string";
      return;
    }
    if (mode === "csi") {
      if (n >= 0x40 && n <= 0x7e) mode = "text";
      else if (n === 0x1b) mode = "escape";
      return;
    }
    if (mode === "escape") {
      if (char === "[") mode = "csi";
      else if (char === "]") mode = "osc";
      else if (["P", "X", "^", "_"].includes(char)) mode = "string";
      else if (n >= 0x20 && n <= 0x2f) mode = "intermediate";
      else if (n !== 0x1b) mode = "text";
      return;
    }
    if (mode === "intermediate") {
      if (n >= 0x30 && n <= 0x7e) mode = "text";
      else if (n === 0x1b) mode = "escape";
      return;
    }
    if (n === 0x1b || n === 0x9b || n === 0x9d || [0x90, 0x98, 0x9e, 0x9f].includes(n)) {
      controlsRemoved = true;
      mode = n === 0x1b ? "escape" : n === 0x9b ? "csi" : n === 0x9d ? "osc" : "string";
    } else emit(char);
  };
  const text = high + chunk;
  high = "";
  for (let i = 0; i < text.length; ) {
    const first = text.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff && i === text.length - 1) {
      high = text[i] ?? "";
      break;
    }
    let char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    i += char.length;
    if (char.length === 1 && first >= 0xd800 && first <= 0xdfff) {
      nonprintable = true;
      char = "�";
    }
    inputBytes += codeBytes(char);
    if (inputBytes > TERMINAL_LIMITS.inputBytes) {
      truncated = true;
      high = "";
      break;
    }
    consume(char);
  }
  const kept = retain(input, output.join(""));
  return {
    ...previous,
    [stream]: { parts: kept.parts, bytes: kept.bytes, mode, high, afterCR },
    inputBytes,
    truncated: truncated || kept.clipped,
    controlsRemoved,
    nonprintable,
  };
}
export function finishTerminal(text: TerminalText): TerminalText {
  return {
    ...text,
    stdout: { ...text.stdout, high: "" },
    stderr: { ...text.stderr, high: "" },
    nonprintable: text.nonprintable || !!text.stdout.high || !!text.stderr.high,
    controlsRemoved:
      text.controlsRemoved || text.stdout.mode !== "text" || text.stderr.mode !== "text",
  };
}
