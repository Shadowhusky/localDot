import { createElement, Fragment, type ReactNode } from "react";

// The app's words in the language the person chose. The English as written in the code is both what
// shows in English and each message's key, so a message is written once, where it is used; another
// language is a catalog of translations of those keys. A language's catalog loads as this module
// does, before any module that imports it runs, so words a module fixes as it loads are in it too,
// and changing language reloads the page.
//
// In a message, `{0}`, `{1}` stand for its values in order, and `#` in a count for the number.

export type Locale = "en" | "zh-CN";
export type LocaleChoice = Locale | "system";
export type Catalog = Readonly<Record<string, string>>;

export const LOCALES: readonly Locale[] = ["en", "zh-CN"];
export const LOCALE_KEY = "localdot.locale.v1";
// Each language by its own name, as a language list shows them.
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  "zh-CN": "简体中文",
};

let current: Locale = "en";
let catalog: Catalog = {};

function read(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

// What the person chose on this device; nothing chosen follows the device.
export function localeChoice(): LocaleChoice {
  const saved = read();
  return saved === "system" || LOCALES.includes(saved as Locale)
    ? (saved as LocaleChoice)
    : "system";
}

// The device's own language, where the app has it: any Chinese reads Simplified Chinese for now.
export function deviceLocale(
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): Locale {
  for (const language of languages) {
    const lower = language.toLowerCase();
    if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
    if (lower === "en" || lower.startsWith("en-")) return "en";
  }
  return "en";
}

export const resolveLocale = (choice: LocaleChoice): Locale =>
  choice === "system" ? deviceLocale() : choice;

// The language the app shows, with its translations; English needs none.
export function setLocale(next: Locale, entries: Catalog = {}): void {
  current = next;
  catalog = next === "en" ? {} : entries;
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

export const locale = (): Locale => current;

// Saves the choice and reloads, so every word on the page, those fixed as modules loaded too, is in
// the new language. False when this browser can't save it.
export function chooseLocale(choice: LocaleChoice): boolean {
  try {
    localStorage.setItem(LOCALE_KEY, choice);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

const keyOf = (parts: readonly string[]) =>
  parts.reduce((key, part, at) => (at ? `${key}{${at - 1}}${part}` : part), "");

const fill = (text: string, values: readonly unknown[]) =>
  text.replace(/\{(\d+)\}/g, (whole, at: string) =>
    Number(at) < values.length ? String(values[Number(at)]) : whole,
  );

// A message in the language on show: t`Saved ${count} files`.
export function t(parts: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  const key = keyOf(parts);
  return fill(catalog[key] ?? key, values);
}

// A message held as a plain string, such as a value in a table of words: tr("Done"). The words must
// be written where tr is called, so the catalog check can find them.
export function tr(source: string, ...values: readonly (string | number)[]): string {
  return fill(catalog[source] ?? source, values);
}

// The same English with another meaning, told apart by what it names: tc("button", "Reset") beside a
// tc("status", "Reset"). The catalog keys it "[button] Reset"; with none there it reads as written.
export function tc(
  context: string,
  source: string,
  ...values: readonly (string | number)[]
): string {
  return fill(catalog[`[${context}] ${source}`] ?? source, values);
}

// A message with elements inside it, such as a link or bold words: rich`Open ${<b>Keys</b>} to unlock`.
export function rich(parts: TemplateStringsArray, ...values: readonly ReactNode[]): ReactNode {
  const key = keyOf(parts);
  const text = catalog[key] ?? key;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\d+)\}/g)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(createElement(Fragment, { key: `v${out.length}` }, values[Number(match[1])]));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 && typeof out[0] === "string" ? out[0] : out;
}

const plurals = new Map<Locale, Intl.PluralRules>();

// "3 steps": the number and the noun that goes with it. A catalog takes the English pair as
// "one|other" and gives the whole phrase, `#` standing for the number.
export function plural(value: number, one: string, other: string): string {
  const number = value.toLocaleString(current);
  const translated = catalog[`${one}|${other}`];
  if (translated !== undefined) return translated.replaceAll("#", number);
  const rules = plurals.get("en") ?? new Intl.PluralRules("en");
  plurals.set("en", rules);
  return `${number} ${rules.select(value) === "one" ? one : other}`;
}

// Every module asking for a message imports this one, so each waits here for the catalog. English
// awaits nothing and so runs on at once.
const startLocale = resolveLocale(localeChoice());
if (startLocale !== "en") {
  try {
    setLocale(startLocale, (await import("./zh-CN/index.ts")).zhCN);
  } catch {
    // A catalog that couldn't load leaves the app in English, not blank.
  }
}
