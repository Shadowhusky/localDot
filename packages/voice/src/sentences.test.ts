import { describe, expect, it } from "vitest";
import { detectLang, replyLang } from "./lang.ts";
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

  it("keeps numbers, times and links whole when it cuts at a clause", () => {
    expect(split("You have 1,024 files left.")).toEqual(["You have 1,024 files left."]);
    expect(split("Meet me at 10:30 tomorrow.")).toEqual(["Meet me at 10:30 tomorrow."]);
    expect(split("See https://example.com for the docs.")).toEqual([
      "See https://example.com for the docs.",
    ]);
    expect(split("下午3:45开会。")).toEqual(["下午3:45开会。"]);
    expect(split(`${"word ".repeat(39)}1,024 more.`)).toEqual([
      "word ".repeat(39).trim(),
      "1,024 more.",
    ]);
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

  it("reads a katakana middle dot in a Chinese name as punctuation", () => {
    expect(detectLang("史蒂夫・乔布斯创立了苹果公司。")).toBe("zh");
    expect(detectLang("ジョン・スミスです。")).toBe("ja");
  });

  it("reads kanji-only text with a character only Chinese writes as Chinese, whatever the reply", () => {
    expect(split("你好，我在这里。").map((s) => detectLang(s, "ja"))).toEqual(["zh", "zh"]);
  });

  it("never takes a Japanese kanji for a character only Chinese writes", () => {
    // Every JIS X 0208 character, read back from its two EUC-JP bytes.
    const eucJp = new TextDecoder("euc-jp");
    const misread: string[] = [];
    for (let row = 0xa1; row <= 0xfe; row++) {
      for (let cell = 0xa1; cell <= 0xfe; cell++) {
        const ch = eucJp.decode(new Uint8Array([row, cell]));
        if (detectLang(ch, "ja") !== "ja") misread.push(ch);
      }
    }
    expect(misread).toEqual([]);
  });
});

describe("replyLang", () => {
  it("keeps a Chinese reply's Chinese sentences Chinese when it names one title in kana", () => {
    const reply =
      "我昨天又看了一遍《となりのトトロ》。画面很美，色彩也很温柔。你小时候看过这部电影吗？";
    const hint = replyLang(reply);
    expect(hint).toBe("zh");
    expect(split(reply).map((s) => detectLang(s, hint))).toEqual(["ja", "zh", "zh"]);
  });

  it("lets a Japanese reply settle its kanji-only sentences as Japanese", () => {
    const reply = "東京に着いたよ。本日晴天。明日も晴れるといいね。";
    const hint = replyLang(reply);
    expect(hint).toBe("ja");
    expect(split(reply).map((s) => detectLang(s, hint))).toEqual(["ja", "ja", "ja"]);
  });

  it("is Japanese once kana is a quarter of the reply's CJK characters, and English when Latin leads", () => {
    expect(replyLang("東京都の")).toBe("ja");
    expect(replyLang("你看过トトロ吗？我很喜欢那部动画片。")).toBe("zh");
    expect(replyLang("Meet me at 東京駅 at noon.")).toBe("en");
    expect(replyLang("42!")).toBe("en");
  });
});
