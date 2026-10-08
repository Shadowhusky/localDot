// A message names the files sent with it in a block at its end, which dot reads and the thread shows
// as chips under the message instead.
const HEADING = "Attached files on this computer:";

export function withAttachments(text: string, paths: readonly string[]): string {
  return paths.length
    ? `${text}\n\n${HEADING}\n${paths.map((path) => `- ${path}`).join("\n")}`
    : text;
}

export function splitAttachments(text: string): { body: string; files: string[] } {
  const at = text.lastIndexOf(`\n\n${HEADING}\n`);
  if (at < 0) return { body: text, files: [] };
  const lines = text.slice(at + HEADING.length + 3).split("\n");
  if (lines.some((line) => !line.startsWith("- ") || !line.slice(2).trim()))
    return { body: text, files: [] };
  return { body: text.slice(0, at), files: lines.map((line) => line.slice(2)) };
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}
