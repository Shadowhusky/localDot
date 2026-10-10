// A conservative, provider-independent estimate, not a provider tokenizer. UTF-8 byte
// cost for non-ASCII avoids undercounting CJK/emoji as chars/3. No model call or key needed.
export function memoryTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3) + Buffer.byteLength(text, "utf8") - ascii;
}
export function memoryBudget(contextTokens = 128_000): number {
  return Math.min(2_400, Math.max(0, Math.floor(contextTokens * 0.04)));
}
