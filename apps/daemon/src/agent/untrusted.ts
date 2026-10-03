// Text that came from the computer (web pages, files, command output) reaches the model inside an
// <untrusted> block, and the system prompt says such text is data, never instructions (Review
// Focus 1). The text cannot close the block early: every "<untrusted" and "</untrusted" in it is
// defused first, whatever its case or spacing.
const TAG = /<\s*(\/?)\s*untrusted/gi;

export function untrusted(source: string, text: string): string {
  const safeSource = source.replace(/["<>\n\r]/g, " ").slice(0, 300);
  const body = text.replace(TAG, (_m, slash: string) => `‹${slash}untrusted`);
  return `<untrusted source="${safeSource}">\n${body}\n</untrusted>`;
}
