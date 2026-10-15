import { ZH } from "./i18n/zh.ts";

export type Lang = "en" | "zh";
const STORED = "localdot.lang";

// The language the page reads in: the one the address names, else the one the visitor picked, else
// their system's. index.html's first script makes the same choice before the page is drawn.
function startLang(): Lang {
  const named = new URLSearchParams(globalThis.location?.search ?? "").get("lang");
  if (named === "en" || named === "zh") return named;
  try {
    const picked = localStorage.getItem(STORED);
    if (picked === "en" || picked === "zh") return picked;
  } catch {}
  return /^zh\b/i.test(globalThis.navigator?.language ?? "") ? "zh" : "en";
}

export const LANG: Lang = startLang();

// An English line in the page's language, its {slots} filled.
export function t(en: string, fill: Readonly<Record<string, string | number>> = {}): string {
  const line = LANG === "zh" ? (ZH[en] ?? en) : en;
  return line.replace(/\{(\w+)\}/g, (slot, name: string) =>
    name in fill ? String(fill[name]) : slot,
  );
}

// How long dot talks for a line, a word at a time as the app times it, a Chinese character reading
// in about half a word's time.
export function talkMs(line: string): number {
  const chinese = line.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const words = line.match(/[A-Za-z0-9][\w'’-]*/g)?.length ?? 0;
  return Math.min(2200, Math.max(500, (words + Math.ceil(chinese / 2)) * 170));
}

// Reads the page in another language from now on, and the address says so, for a browser that
// keeps nothing and for a link to the page.
export function pickLang(lang: Lang): void {
  try {
    localStorage.setItem(STORED, lang);
  } catch {}
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  location.replace(url);
}

const words = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

// Full-width punctuation inside a headline, set close as display type sets it: each mark in its own
// span, which the stylesheet pulls in.
function closeUp(el: HTMLElement): void {
  const parts = (el.textContent ?? "").split(/([，、：；])/);
  el.replaceChildren(
    ...parts.map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part);
      const mark = document.createElement("span");
      mark.className = "zh-punct";
      mark.textContent = part;
      return mark;
    }),
  );
}

// The page's own words in its language: each [data-i18n] element's text, keyed by the attribute's
// value or else its English; a [data-i18n-list]'s items joined as the language joins them; and each
// [data-i18n-label]'s aria-label.
export function translatePage(fill: Readonly<Record<string, string | number>>): void {
  if (LANG !== "en") {
    document.documentElement.lang = "zh-Hans";
    document.documentElement.dataset.lang = "zh";
    for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n || words(el), fill);
      if (el.matches("h1, h2, h3")) closeUp(el);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-list]"))
      el.textContent = (el.dataset.i18nList ?? "")
        .split("|")
        .map((item) => t(item))
        .join("、");
    // A few lines carry a link; their Chinese, with its markup, is the site's own.
    for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
      const html = el.dataset.i18nHtml ? ZH[el.dataset.i18nHtml] : undefined;
      if (html) el.innerHTML = html;
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-label]"))
      el.setAttribute("aria-label", t(el.getAttribute("aria-label") ?? ""));
    document.title = t(document.title);
    const description = document.querySelector('meta[name="description"]');
    description?.setAttribute("content", t(description.getAttribute("content") ?? ""));
  }
  document.documentElement.dataset.i18nDone = "";
}
