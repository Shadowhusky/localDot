import { describe, expect, it } from "vitest";
import { voiceSettingsFromEnv } from "./settings.ts";

describe("voiceSettingsFromEnv", () => {
  it("defaults to the local voice, no fallback, the Azure free tier and no ElevenLabs spending", () => {
    expect(voiceSettingsFromEnv({})).toEqual({
      output: "local",
      fallback: "none",
      azure: null,
      elevenlabs: null,
      limits: { azure: 500_000, elevenlabs: 0 },
    });
  });

  it("reads the opt-ins, credentials and monthly caps", () => {
    const settings = voiceSettingsFromEnv({
      LOCALDOT_VOICE_OUTPUT: "elevenlabs",
      LOCALDOT_VOICE_FALLBACK: "azure",
      AZURE_SPEECH_KEY: "a-key",
      AZURE_SPEECH_REGION: "eastus",
      ELEVENLABS_API_KEY: "e-key",
      ELEVENLABS_VOICE_ID: "v1",
      LOCALDOT_ELEVENLABS_CHARS_PER_MONTH: "20000",
    });
    expect(settings).toMatchObject({
      output: "elevenlabs",
      fallback: "azure",
      azure: { key: "a-key", region: "eastus", voice: "zh-CN-XiaoxiaoMultilingualNeural" },
      elevenlabs: { key: "e-key", voiceId: "v1", model: "eleven_v4_turbo" },
      limits: { azure: 500_000, elevenlabs: 20_000 },
    });
  });

  it("ignores values it does not understand", () => {
    const settings = voiceSettingsFromEnv({
      LOCALDOT_VOICE_OUTPUT: "loud",
      LOCALDOT_VOICE_FALLBACK: "elevenlabs",
      AZURE_SPEECH_KEY: "a-key",
      LOCALDOT_AZURE_CHARS_PER_MONTH: "-5",
    });
    expect(settings).toMatchObject({
      output: "local",
      fallback: "none",
      azure: null,
      limits: { azure: 500_000 },
    });
  });
});
