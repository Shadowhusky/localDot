import { describe, expect, it } from "vitest";
import { detectLang } from "./lang.ts";
import { MAX_UNITS, SentenceSplitter, speechUnits } from "./sentences.ts";

const split = (text: string) => {
  const s = new SentenceSplitter();
  return [...s.push(text), ...s.flush()];
};

describe("SentenceSplitter", () => {
  it("cuts the first sentence at its first clause so the voice starts early", () => {
    expect(
      split("Hey, you're finally back. I sorted your downloads folder while you were gone."),
    ).toEqual([
      "Hey,",
      "you're finally back.",
      "I sorted your downloads folder while you were gone.",
    ]);
  });

  it("splits Chinese and Japanese on full-width punctuation and keeps closing quotes", () => {
    expect(split("你终于回来了。说实话，里面简直一团糟！")).toEqual([
      "你终于回来了。",
      "说实话，里面简直一团糟！",
    ]);
    expect(split("「やっと帰ってきたのね。」正直、ひどい有様だった。")).toEqual([
      "「やっと帰ってきたのね。」",
      "正直、ひどい有様だった。",
    ]);
  });

  it("waits for the character after a period before cutting, and keeps decimals whole", () => {
    const s = new SentenceSplitter();
    expect(s.push("Version 2.5 is out.")).toEqual([]);
    expect(s.push(" Try it")).toEqual(["Version 2.5 is out."]);
    expect(s.flush()).toEqual(["Try it"]);
  });

  it("gives the same sentences whether the text arrives at once or one character at a time", () => {
    const text = "我用 React 写的。It works, mostly! 「次は日本語で話すね。」最後に、もう一つ。";
    const s = new SentenceSplitter();
    const streamed = [...text].flatMap((ch) => s.push(ch));
    expect([...streamed, ...s.flush()]).toEqual(split(text));
  });

  it("cuts a very long sentence at a clause, then at a space, never past the limit", () => {
    const long = `${"word ".repeat(30)}and, ${"more ".repeat(40)}end.`;
    const pieces = split(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(speechUnits(piece)).toBeLessThanOrEqual(MAX_UNITS + 1);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(long.trim().replace(/\s+/g, " "));
    const cjk = "这".repeat(200);
    const cjkPieces = split(cjk);
    expect(cjkPieces.join("")).toBe(cjk);
    for (const piece of cjkPieces) expect(speechUnits(piece)).toBeLessThanOrEqual(MAX_UNITS + 1);
  });

  it("drops pieces with nothing to say", () => {
    expect(split("…… !! \n\n ok.")).toEqual(["ok."]);
    expect(split("   ")).toEqual([]);
  });
});

describe("detectLang", () => {
  it("reads the dominant script, kana meaning Japanese", () => {
    expect(detectLang("你终于回来了。")).toBe("zh");
    expect(detectLang("やっと帰ってきたのね。")).toBe("ja");
    expect(detectLang("You're finally back.")).toBe("en");
    expect(detectLang("我用 React 写的。")).toBe("zh");
    expect(detectLang("Run npm install, 然后重启。")).toBe("en");
  });

  it("lets the reply's language settle kanji-only text and text with no letters", () => {
    expect(detectLang("東京都庁", "ja")).toBe("ja");
    expect(detectLang("東京都庁")).toBe("zh");
    expect(detectLang("42!", "ja")).toBe("ja");
    expect(detectLang("42!")).toBe("en");
  });
});
