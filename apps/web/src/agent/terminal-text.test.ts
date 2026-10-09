import type { LocalDotEvent } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import {
  appendTerminal,
  emptyTerminal,
  finishTerminal,
  TERMINAL_LIMITS,
  terminalDisplayed,
  utf8Bytes,
} from "./terminal-text.ts";

const shown = (text: ReturnType<typeof emptyTerminal>, stream: "stdout" | "stderr" = "stdout") =>
  terminalDisplayed(text, stream).text;
describe("incremental non-executing terminal text", () => {
  it("removes OSC52 across every split while retaining surrounding text", () => {
    const source = "left\x1b]52;c;clipboard-sentinel\x07right";
    for (let i = 0; i <= source.length; i++) {
      let t = appendTerminal(emptyTerminal(), "stdout", source.slice(0, i));
      t = appendTerminal(t, "stdout", source.slice(i));
      expect(shown(t)).toBe("leftright");
      expect(t.controlsRemoved).toBe(true);
    }
  });
  it("drops OSC8 links, SGR, DCS and all control-string terminators without producing a link", () => {
    for (const sequence of [
      "\x1b]8;;https://example.test\x07label\x1b]8;;\x07",
      "\x1b[31mred\x1b[0m",
      "\x1bPdanger\x1b\\safe",
      "\u009d52;c;danger\u009csafe",
      "\x1b^danger\x1b\\safe",
    ]) {
      let t = emptyTerminal();
      for (const char of sequence) t = appendTerminal(t, "stdout", char);
      expect(shown(t)).not.toContain("danger");
      expect(shown(t)).not.toContain("https:");
      expect(
        [...shown(t)].some((char) => {
          const code = char.charCodeAt(0);
          return code <= 8 || code === 27 || (code >= 127 && code <= 159);
        }),
      ).toBe(false);
    }
  });
  it("isolates stderr while stdout is inside an unterminated escape string", () => {
    let t = appendTerminal(emptyTerminal(), "stdout", "out\x1b]52;c;hidden");
    t = appendTerminal(t, "stderr", "error 中\n");
    t = appendTerminal(t, "stdout", "-payload\x07tail");
    expect(shown(t)).toBe("outtail");
    expect(shown(t, "stderr")).toBe("error 中\n");
  });
  it("makes carriage returns additive and backspace incapable of removing provenance", () => {
    const t = appendTerminal(emptyTerminal(), "stdout", "first\rsecond\bthird\r\nfourth\0");
    expect(shown(t)).toBe("first\nsecondthird\nfourth");
    expect(t.nonprintable).toBe(true);
  });
  it("keeps split surrogate pairs intact, and omits a trailing malformed unit on finish", () => {
    let t = appendTerminal(emptyTerminal(), "stdout", "中\ud83d");
    t = appendTerminal(t, "stderr", "other");
    t = appendTerminal(t, "stdout", "\ude00文");
    expect(shown(t)).toBe("中😀文");
    expect(shown(t, "stderr")).toBe("other");
    t = finishTerminal(appendTerminal(t, "stdout", "\ud83d"));
    expect(t.stdout.high).toBe("");
    expect(t.nonprintable).toBe(true);
  });
  it("bounds both stream bytes on character boundaries and does not starve stderr", () => {
    let t = appendTerminal(emptyTerminal(), "stdout", "😀".repeat(25_000));
    t = appendTerminal(t, "stderr", "中".repeat(25_000));
    expect(t.stdout.bytes + t.stderr.bytes).toBeLessThanOrEqual(TERMINAL_LIMITS.bytes);
    expect(utf8Bytes(shown(t)) + utf8Bytes(shown(t, "stderr"))).toBeLessThanOrEqual(
      TERMINAL_LIMITS.bytes,
    );
    expect(shown(t).isWellFormed()).toBe(true);
    expect(shown(t, "stderr").isWellFormed()).toBe(true);
    expect(t.truncated).toBe(true);
  });
  it("bounds line count and input scanning even when another packet keeps arriving", () => {
    let t = appendTerminal(emptyTerminal(), "stdout", "x\n".repeat(3000));
    expect(shown(t).split("\n")).toHaveLength(TERMINAL_LIMITS.lines / 2);
    expect(terminalDisplayed(t, "stdout").truncated).toBe(true);
    t = appendTerminal(t, "stdout", "a".repeat(TERMINAL_LIMITS.inputBytes));
    const before = shown(t);
    t = appendTerminal(t, "stdout", "later");
    expect(shown(t)).toBe(before);
    expect(t.truncated).toBe(true);
  });
  it("retains control state before raw projection truncates away its opening prefix", () => {
    const ev = (seq: number, chunk: string) =>
      ({
        v: 1,
        id: String(seq).padStart(26, "0"),
        agent: "main",
        seq,
        t: seq,
        type: "tool.output",
        step: "command",
        data: { stream: "stdout", chunk },
      }) as LocalDotEvent;
    let model = projectAgentEvent(
      emptyAgentModel(),
      ev(0, "visible\x1b]52;c;" + "x".repeat(70_000)),
    );
    model = projectAgentEvent(model, ev(1, "clipboard-sentinel\x07tail"));
    const row = model.steps.get("command");
    if (!row?.terminal) throw new Error("Expected projected command terminal");
    expect(row.outputTruncated).toBe(true);
    expect(shown(row.terminal)).toBe("visibletail");
    expect(shown(row.terminal)).not.toContain("clipboard-sentinel");
  });
  it("does not fabricate dot's words, and keeps only the tail of what it thinks", () => {
    expect(emptyAgentModel().said).toBeUndefined();
    const model = projectAgentEvent(emptyAgentModel(), {
      v: 1,
      id: "00000000000000000000000000",
      agent: "main",
      seq: 0,
      t: 0,
      type: "thought.delta",
      data: { text: "中".repeat(30_000) },
    } as LocalDotEvent);
    expect(model.said?.text).toHaveLength(600);
  });
});
