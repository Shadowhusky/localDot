import { PERSONAS, personaOf } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { DEMOS } from "./hero/catalog.ts";
import { ZH, ZH_GREETINGS, ZH_LINES } from "./i18n/zh.ts";
import { t, talkMs } from "./i18n.ts";
import { RING, ringHtml, rolesHtml } from "./story/content.ts";

const slots = (line: string) => [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Vite reads these at build time, so each glob's options are written out where it is.
const PAGE =
  Object.values(
    import.meta.glob<string>("../index.html", { query: "?raw", import: "default", eager: true }),
  )[0] ?? "";
const CODE = Object.values(
  import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const TIMELINES = import.meta.glob<string>("../public/demos/*/timeline.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
// Names, and the designer's French, read the same in Chinese.
const KEPT = new Set<string>([...RING, "Voilà. C'est magnifique."]);
const words = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

// Everything the page marks for translation, as translatePage looks it up.
function pageKeys(): string[] {
  const html = PAGE.replace("<!-- roles -->", rolesHtml()).replace("<!-- ring -->", ringHtml());
  const page = new DOMParser().parseFromString(html, "text/html");
  const all = (selector: string) => [...page.querySelectorAll<HTMLElement>(selector)];
  return [
    ...all("[data-i18n]").map((el) => el.dataset.i18n || words(el)),
    ...all("[data-i18n-list]").flatMap((el) => (el.dataset.i18nList ?? "").split("|")),
    ...all("[data-i18n-html]").map((el) => el.dataset.i18nHtml ?? ""),
    ...all("[data-i18n-label]").map((el) => el.getAttribute("aria-label") ?? ""),
    page.title,
    page.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
  ];
}

// Every line the code hands to t() as it is written.
function codeKeys(): string[] {
  return CODE.flatMap((code) =>
    [...code.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string,
    ),
  );
}

// The words the demos bring: what each one asks, who does it, and its recording's title.
function demoKeys(): string[] {
  return DEMOS.flatMap(({ id, ask, persona }) => [
    ask,
    personaOf(persona).name,
    (JSON.parse(TIMELINES[`../public/demos/${id}/timeline.json`] ?? "{}") as { title: string })
      .title,
  ]);
}

describe("the page's languages", () => {
  it("fills a line's slots", () => {
    expect(t("A real task with {model}, sped up.", { model: "DeepSeek Flash" })).toBe(
      "A real task with DeepSeek Flash, sped up.",
    );
  });

  it("keeps every slot of the English in its Chinese", () => {
    for (const [en, zh] of Object.entries(ZH)) {
      if (en === "models.body") continue;
      expect(slots(zh), en).toEqual(slots(en));
    }
    expect(slots(ZH["models.body"] ?? "")).toEqual(["n"]);
  });

  it("has Chinese for every word the site shows", () => {
    const missing = [...new Set([...pageKeys(), ...codeKeys(), ...demoKeys()])].filter(
      (key) => ZH[key] === undefined && !KEPT.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("keeps no Chinese for words the site no longer says", () => {
    const said = new Set([...pageKeys(), ...codeKeys(), ...demoKeys()]);
    expect(Object.keys(ZH).filter((key) => !said.has(key))).toEqual([]);
  });

  it("lets dot talk as long for a Chinese line as for the English it stands for", () => {
    expect(talkMs("I check every number twice")).toBe(5 * 170);
    expect(talkMs("交给你之前，我会再算一遍。")).toBe(6 * 170);
    expect(talkMs("嗨")).toBe(500);
    expect(talkMs("给我一段长视频，我把最值得看的三十秒挑出来，再配上字幕和音乐。")).toBe(2200);
  });

  it("gives every dot and every time of day its Chinese words", () => {
    for (const id of Object.keys(PERSONAS))
      expect(ZH_LINES[id as keyof typeof ZH_LINES]?.length).toBeGreaterThan(0);
    for (const lines of Object.values(ZH_GREETINGS)) expect(lines.length).toBeGreaterThan(0);
  });
});
