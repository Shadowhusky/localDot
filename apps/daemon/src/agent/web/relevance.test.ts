import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bingImages, type SearchHit } from "./engines.ts";
import { queryTerms, relevantTo } from "./relevance.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ESCUTCHEON = "antique English brass chest lock escutcheon ornate engraved";
const hit = (title: string, url = "https://example.com/", image?: string): SearchHit => ({
  title,
  url,
  site: "example.com",
  ...(image ? { image } : {}),
});

describe("what a query is about", () => {
  it("leaves out grammar, kinds of file, languages and search operators", () => {
    expect(queryTerms("antique English oak coffer carved panels")).toEqual({
      words: ["antique", "oak", "coffer", "carved", "panel"],
      pairs: [],
    });
    expect(queryTerms("Photos of the Château -wallpaper site:example.com")).toEqual({
      words: ["chateau"],
      pairs: [],
    });
    expect(queryTerms("English").words).toEqual([]);
  });

  it("reads writing without spaces as pairs of characters, leaving out words for pictures", () => {
    expect(queryTerms("古董橡木箱子图片")).toEqual({
      words: [],
      pairs: ["古董", "董橡", "橡木", "木箱", "箱子", "子图"],
    });
    expect(queryTerms("東京タワー 夜景 photo")).toEqual({
      words: [],
      pairs: ["東京", "京タ", "タワ", "ワー", "夜景"],
    });
    expect(queryTerms("猫").pairs).toEqual(["猫"]);
  });
});

describe("relevant image results", () => {
  it("keeps none of the pictures Bing shows anyone, and the results it found for the query", () => {
    const keep = relevantTo(ESCUTCHEON);
    expect(bingImages.read(fixture("bing-images-unrelated.html")).filter(keep)).toEqual([]);
    const answered = bingImages.read(fixture("bing-images-escutcheon.html"));
    expect(answered.filter(keep).length).toBeGreaterThan(30);
  });

  it("drops what the task's searches were shown, which shares only a common word or none", () => {
    expect(
      relevantTo("17th century English oak iron bound coffer antique chest")(
        hit(
          "Noah the Elder - Happy Feet Wiki, The Movie-Based Happy Feet Encyclopedia",
          "http://happyfeet.wikia.com/wiki/Noah_the_Elder",
        ),
      ),
    ).toBe(false);
    const coffer = relevantTo("antique English oak coffer carved panels");
    expect(
      coffer(
        hit(
          "The Magazine of Art 1896",
          "https://commons.wikimedia.org/wiki/File:The_Magazine_of_Art_1896.djvu",
        ),
      ),
    ).toBe(false);
    expect(
      relevantTo(ESCUTCHEON)(
        hit(
          "Fruits and Vegetables in English: Vocabulary List, IPA & Examples - ESL ...",
          "https://eslforums.com/list-of-fruits-and-vegetables/",
        ),
      ),
    ).toBe(false);
    expect(
      relevantTo("medieval iron bound oak coffer with three locks")(
        hit("Medieval Castle by the Water"),
      ),
    ).toBe(false);
    expect(coffer(hit("18th Century Georgian English Carved Oak Coffer | Chairish"))).toBe(true);
  });

  it("matches a short query on one word, in a plural, or in the page's or picture's address", () => {
    const panda = relevantTo("red panda");
    expect(panda(hit("Adorable Red Pandas"))).toBe(true);
    expect(panda(hit("Zoo news", "https://zoo.example/animals/red-panda-cub"))).toBe(true);
    expect(panda(hit("Our zoo", "https://zoo.example/", "https://cdn.example/red_panda.jpg"))).toBe(
      true,
    );
    expect(panda(hit("Giant panda eating bamboo"))).toBe(true);
    expect(panda(hit("Monthly 2026 Calendar Background Images, HD Pictures"))).toBe(false);
  });

  it("matches writing without spaces inside the title or a decoded address", () => {
    const tower = relevantTo("埃菲尔铁塔");
    expect(tower(hit("巴黎埃菲尔铁塔高清图片下载-正版图片"))).toBe(true);
    expect(
      tower(hit("Paris", "https://example.com/%E5%9F%83%E8%8F%B2%E5%B0%94%E9%93%81%E5%A1%94.html")),
    ).toBe(true);
    expect(tower(hit("上海东方明珠铁塔"))).toBe(false);
    expect(tower(hit("Monthly 2026 Calendar Background Images"))).toBe(false);
    const chest = relevantTo("古董 橡木 箱子");
    expect(bingImages.read(fixture("bing-images-cjk.html")).every(chest)).toBe(true);
    expect(chest(hit("古董花瓶"))).toBe(true);
    expect(chest(hit("高清图片下载"))).toBe(false);
    expect(relevantTo("사진 고양이")(hit("귀여운 고양이 사진"))).toBe(true);
  });

  it("keeps every result of a query only about nothing", () => {
    expect(relevantTo("English photos")(hit("Anything at all"))).toBe(true);
  });
});
