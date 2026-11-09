// Text that came from the computer (web pages, files, command output) reaches the model inside an
// <untrusted> block, and the system prompt says such text is data, never instructions (Review
// Focus 1). The text cannot close the block early: every tag that reads as "<untrusted" or
// "</untrusted" is defused first, whatever its case or spacing, and whether it is written with a
// look-alike bracket, slash or letters (full-width, small, angle, modifier) or with invisible
// characters or marks inside.
const OPEN = "<\uFF1C\uFE64\u2039\u3008\u27E8\u2329\u02C2\u1438";
const SLASH = "/\uFF0F\u2044\u2215\u29F8";
const TAG = new RegExp(
  `[${OPEN}][\\s\\p{Cf}\\p{Mn}]*([${SLASH}]?)[\\s\\p{Cf}\\p{Mn}]*([\\p{L}\\p{Cf}\\p{Mn}]{9,40})`,
  "giu",
);

export function untrusted(source: string, text: string): string {
  const safeSource = source.replace(/["<>\n\r]/g, " ").slice(0, 300);
  const body = text.replace(TAG, (tag, slash: string, word: string) => {
    const read = word
      .replace(/[\p{Cf}\p{Mn}]/gu, "")
      .normalize("NFKC")
      .toLowerCase();
    return read.startsWith("untrusted") ? `\u2039${slash ? "/" : ""}${read}` : tag;
  });
  return `<untrusted source="${safeSource}">\n${body}\n</untrusted>`;
}
