import { describe, expect, it } from "vitest";
import { SpeechSamples } from "./pcm.ts";

describe("microphone PCM resampling", () => {
  it.each([16_000, 44_100, 48_000, 96_000])("keeps duration and level at %i Hz", (rate) => {
    const output: number[] = [];
    const samples = new SpeechSamples(rate, (block) => output.push(...block));
    const input = new Float32Array(rate).fill(0.25);
    for (let i = 0; i < input.length; i += 128) {
      samples.push(input.subarray(i, i + 128));
      if (i % 2048 === 0) samples.flush();
    }
    samples.flush();
    expect(output).toHaveLength(16_000);
    expect(output.every((value) => value === 0.25)).toBe(true);
  });

  it("preserves speech frequencies and never repeats a flushed tail", () => {
    const output: number[] = [];
    const samples = new SpeechSamples(48_000, (block) => output.push(...block));
    samples.push(
      Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000)),
    );
    samples.flush();
    samples.flush();
    expect(output).toHaveLength(16_000);
    const crossings = output.filter((value, i) => value > 0 && (output[i - 1] ?? 0) <= 0).length;
    expect(crossings).toBe(440);
  });
});
