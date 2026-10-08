// Recognition is an accidental-paste safeguard, not a universal secret classifier. Bare
// hex/base64 keys, passwords, renamed/obfuscated credentials and file contents are not detected.
export const KEY_SCAN_CHARS = 8000;
export const KEY_SCAN_MATCHES = 16;
export type KeyHint =
  | "Anthropic"
  | "Claude plan token"
  | "OpenAI"
  | "Google"
  | "Groq"
  | "OpenRouter"
  | "xAI"
  | "Perplexity"
  | "API key";
export interface KeyMatch {
  readonly start: number;
  readonly end: number;
  readonly hint: KeyHint;
  readonly provider?: "anthropic" | "openai" | "google" | "groq" | "openrouter" | "xai";
}
export interface KeyScan {
  readonly matches: readonly KeyMatch[];
  readonly overflow: boolean;
}
// A Claude plan's sign-in, refresh or session token. Anthropic lets no other app store or send
// one, so it has no provider and is refused wherever it sits, quoted or after an export line.
const CLAUDE_PLAN = /sk-ant-(?:oat|ort|sid)\d{2}-/;
export const claudePlanToken = (text: string) => CLAUDE_PLAN.test(text);
export const CLAUDE_PLAN_REFUSAL =
  "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";

const RULES: readonly { pattern: RegExp; hint: KeyHint; provider?: KeyMatch["provider"] }[] = [
  {
    pattern: new RegExp(`${CLAUDE_PLAN.source}[A-Za-z0-9_-]{32,8000}$`),
    hint: "Claude plan token",
  },
  {
    pattern: /^sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{32,8000}$/,
    hint: "Anthropic",
    provider: "anthropic",
  },
  {
    pattern: /^sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,8000}$/,
    hint: "OpenAI",
    provider: "openai",
  },
  { pattern: /^AIza[A-Za-z0-9_-]{35}$/, hint: "Google", provider: "google" },
  // The long AQ. form is treated conservatively as a Google authorization-key candidate.
  { pattern: /^AQ\.[A-Za-z0-9_.-]{64,8000}$/, hint: "Google", provider: "google" },
  { pattern: /^gsk_[A-Za-z0-9_-]{32,8000}$/, hint: "Groq", provider: "groq" },
  { pattern: /^sk-or-v1-[A-Za-z0-9_-]{32,8000}$/, hint: "OpenRouter", provider: "openrouter" },
  { pattern: /^xai-[A-Za-z0-9_-]{32,8000}$/, hint: "xAI", provider: "xai" },
  { pattern: /^pplx-[A-Za-z0-9_-]{32,8000}$/, hint: "Perplexity" },
  // Legacy OpenAI and DeepSeek share this shape; the provider cannot be inferred from it.
  { pattern: /^sk-[A-Za-z0-9]{32,64}$/, hint: "API key" },
];

// At most 8000 UTF-16 code units, one token walk, a fixed rule count and sixteen metadata spans.
// A fresh local regexp has no shared cursor. Results contain no credential text or preview.
export function scanKeyLike(text: string): KeyScan {
  if (text.length > KEY_SCAN_CHARS) return { matches: [], overflow: true };
  const matches: KeyMatch[] = [];
  for (const token of text.matchAll(/AQ\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+/g)) {
    const rule = RULES.find((rule) => rule.pattern.test(token[0]));
    if (!rule) continue;
    if (matches.length === KEY_SCAN_MATCHES) return { matches, overflow: true };
    matches.push({
      start: token.index,
      end: token.index + token[0].length,
      hint: rule.hint,
      ...(rule.provider ? { provider: rule.provider } : {}),
    });
  }
  return { matches, overflow: false };
}
export function keyLikePresent(text: string): boolean {
  const scan = scanKeyLike(text);
  return scan.overflow || scan.matches.length > 0;
}
