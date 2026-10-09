import { qrModules } from "../../../packages/protocol/src/qr.ts";

const QUIET = 4;
// Explicit black and white from the 256-colour palette, so the code scans on dark and light
// terminal themes alike.
const DARK = 16;
const LIGHT = 231;

/** A QR code as terminal lines. Each character is an upper half block that stacks two module
 * rows: its foreground is the top module and its background the bottom one. Null when the text
 * is too long for a code. */
export function terminalQr(text: string): string[] | null {
  const modules = qrModules(text);
  if (!modules) return null;
  const size = modules.length + QUIET * 2;
  const shade = (x: number, y: number) => (modules[y - QUIET]?.[x - QUIET] === true ? DARK : LIGHT);
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    let previous = "";
    for (let x = 0; x < size; x++) {
      const colours = `\x1b[38;5;${shade(x, y)};48;5;${shade(x, y + 1)}m`;
      line += colours === previous ? "▀" : `${colours}▀`;
      previous = colours;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}
