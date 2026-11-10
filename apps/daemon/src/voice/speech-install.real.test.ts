import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { speechTranscriber } from "./speech.ts";
import { SPEECH_CATALOG } from "./speech-catalog.ts";
import { hostOfThisComputer } from "./speech-fit.ts";
import { SpeechInstaller } from "./speech-install.ts";

// Opt-in: downloads the real program and model into a temporary home, verifies them, and turns real
// audio into text. Nothing touches ~/.localdot or any Whisper installed by hand.
//   LOCALDOT_TEST_SPEECH_INSTALL=1 pnpm vitest run apps/daemon/src/voice/speech-install.real.test.ts
// LOCALDOT_TEST_SPEECH_TIER picks the tier (balanced). LOCALDOT_TEST_SPEECH_AUDIO is a comma-separated
// list of 16 kHz mono WAVs, the first saying LOCALDOT_TEST_SPEECH_WORDS; without one, macOS's own voice
// reads a line. Each one's words and time are printed.
const on = process.env.LOCALDOT_TEST_SPEECH_INSTALL === "1";
const LINE = "Please open the report from last week.";

function spoken(dir: string): string[] {
  const given = process.env.LOCALDOT_TEST_SPEECH_AUDIO;
  if (given) return given.split(",");
  const wav = join(dir, "line.wav");
  execFileSync("say", ["-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", LINE]);
  return [wav];
}

describe.runIf(on)("a real speech install", { timeout: 60 * 60_000 }, () => {
  it("downloads, verifies, transcribes, then removes itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ld-speech-real-"));
    try {
      const tier = process.env.LOCALDOT_TEST_SPEECH_TIER ?? "balanced";
      const home = join(dir, "home");
      const speech = new SpeechInstaller({
        home,
        catalog: SPEECH_CATALOG,
        host: hostOfThisComputer(),
      });
      await speech.ready;
      expect(speech.status().supported).toBe(true);
      speech.start(tier);
      for (;;) {
        const { job } = speech.status();
        if (job?.state !== "running") break;
        console.log(`${job.stage} ${job.doneBytes}/${job.totalBytes}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (speech.status().job) console.log(speech.status().job?.message);
      expect(speech.status().job).toBeNull();
      const model = speech.model();
      expect(model).not.toBeNull();
      if (!model) return;
      const heard = speechTranscriber(model, { tmp: join(dir, "voice-audio") });
      const said: string[] = [];
      for (const file of spoken(dir)) {
        const started = Date.now();
        said.push(await heard.transcribe(new Uint8Array(readFileSync(file)), null));
        console.log(`${tier} ${file}: "${said.at(-1)}" in ${(Date.now() - started) / 1000} s`);
      }
      expect(said[0]).toMatch(new RegExp(process.env.LOCALDOT_TEST_SPEECH_WORDS ?? "report", "i"));
      await speech.remove();
      expect(existsSync(join(home, "speech"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
