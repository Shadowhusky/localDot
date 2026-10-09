import { describe, expect, it } from "vitest";
import { languageName, modelLanguage, speechLanguage } from "./language.ts";
import { spoken } from "./transcript.ts";
import { loudness, wavFile } from "./wav.ts";

describe("spoken words in the message", () => {
  const at = (value: string, start = value.length, end = start) => ({ value, start, end });

  it("go at the caret with spaces where the words need them", () => {
    expect(spoken(at(""), " hello dot ")).toEqual({ value: "hello dot", caret: 9 });
    expect(spoken(at("Book"), "a table")).toEqual({ value: "Book a table", caret: 12 });
    expect(spoken(at("Book "), "a table").value).toBe("Book a table");
    expect(spoken(at("Hi there", 2), "you").value).toBe("Hi you there");
    expect(spoken(at("Call (x)", 6, 7), "now").value).toBe("Call (now)");
    expect(spoken(at("Done.", 4), "and dusted").value).toBe("Done and dusted.");
  });

  it("replace a selection", () => {
    expect(spoken(at("Book a table", 5, 6), "one").value).toBe("Book one table");
  });

  it("take no spaces in Chinese or Japanese", () => {
    expect(spoken(at("帮我"), "订两个人的位子")).toEqual({ value: "帮我订两个人的位子", caret: 9 });
    expect(spoken(at("明日"), "の天気").value).toBe("明日の天気");
    expect(spoken(at("Open"), "微信").value).toBe("Open微信");
  });

  it("leave the message alone when nothing was said", () => {
    expect(spoken(at("Keep", 2), "  ")).toEqual({ value: "Keep", caret: 2 });
  });
});

describe("the language dot hears", () => {
  it("follows the browser unless one is chosen", () => {
    expect(speechLanguage("auto", ["zh-CN", "en"])).toBe("zh-CN");
    expect(speechLanguage("auto", ["zh-Hant-TW"])).toBe("zh-TW");
    expect(speechLanguage("auto", ["zh"])).toBe("zh-CN");
    expect(speechLanguage("auto", ["ja"])).toBe("ja-JP");
    expect(speechLanguage("auto", ["en-GB"])).toBe("en-GB");
    expect(speechLanguage("auto", ["en"])).toBe("en-US");
    expect(speechLanguage("auto", [])).toBe("en-US");
    expect(speechLanguage("ja-JP", ["en-US"])).toBe("ja-JP");
  });

  it("names it in its own words and gives the computer's model its code", () => {
    expect(languageName("ja-JP")).toBe("日本語");
    expect(languageName("en-GB")).toMatch(/English/);
    expect(modelLanguage("zh-TW")).toBe("zh");
  });
});

describe("a recording for the computer's speech model", () => {
  it("is a 16 kHz mono 16-bit WAV with clamped samples", () => {
    const file = wavFile(new Float32Array([0, 1, -1, 2]));
    const view = new DataView(file.buffer);
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  it("measures loudness from silence to a raised voice", () => {
    expect(loudness(new Float32Array(64))).toBe(0);
    expect(loudness(new Float32Array(64).fill(0.0005))).toBe(0);
    expect(loudness(new Float32Array(64).fill(0.05))).toBeCloseTo(0.68, 2);
    expect(loudness(new Float32Array(64).fill(1))).toBe(1);
  });
});
