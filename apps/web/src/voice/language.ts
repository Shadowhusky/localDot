// The languages dot can hear, by the tag speech engines take.
export const VOICE_LANGUAGES = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "中文（简体）" },
  { value: "zh-TW", label: "中文（繁體）" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
] as const;

export const AUTO_LANGUAGE = "auto";

const REGION: Record<string, string> = {
  en: "en-US",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
};
const TRADITIONAL = /^zh-(tw|hk|mo|hant)/i;

// The language to listen in: the one chosen, or the browser's own.
export function speechLanguage(chosen: string, browser: readonly string[]): string {
  if (chosen !== AUTO_LANGUAGE) return chosen;
  const tag = browser[0] ?? "en-US";
  const base = tag.split("-")[0]?.toLowerCase() ?? "en";
  if (base === "zh") return TRADITIONAL.test(tag) ? "zh-TW" : "zh-CN";
  if (/^[a-z]{2,3}-[A-Z]{2}$/.test(tag)) return tag;
  return REGION[base] ?? "en-US";
}

// What a language is called in its own words, for the Automatic choice and the settings row.
export function languageName(tag: string): string {
  const known = VOICE_LANGUAGES.find((language) => language.value === tag);
  if (known) return known.label;
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

// The two- or three-letter code a speech model on the computer takes.
export const modelLanguage = (tag: string) => tag.split("-")[0]?.toLowerCase() ?? "en";
