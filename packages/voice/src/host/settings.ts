import { AZURE_VOICE, type AzureCredentials } from "./azure.ts";
import { DEFAULT_LIMITS, type Limits } from "./budget.ts";
import { ELEVENLABS_MODEL, type ElevenLabsCredentials } from "./elevenlabs.ts";
import type { FallbackSetting, OutputSetting } from "./router.ts";

export interface VoiceSettings {
  output: OutputSetting;
  fallback: FallbackSetting;
  azure: AzureCredentials | null;
  elevenlabs: ElevenLabsCredentials | null;
  limits: Limits;
}

const OUTPUTS = new Set<string>(["local", "azure", "elevenlabs", "off"]);

// Local voice and no fallback unless the environment opts in; keys stay in this process.
export function voiceSettingsFromEnv(env: NodeJS.ProcessEnv): VoiceSettings {
  const limit = (key: string, fallback: number) => {
    const raw = env[key];
    const value = Number(raw);
    return raw && Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    output: OUTPUTS.has(env.LOCALDOT_VOICE_OUTPUT ?? "")
      ? (env.LOCALDOT_VOICE_OUTPUT as OutputSetting)
      : "local",
    fallback: env.LOCALDOT_VOICE_FALLBACK === "azure" ? "azure" : "none",
    azure:
      env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION
        ? {
            key: env.AZURE_SPEECH_KEY,
            region: env.AZURE_SPEECH_REGION,
            voice: env.LOCALDOT_AZURE_VOICE || AZURE_VOICE,
          }
        : null,
    elevenlabs:
      env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID
        ? {
            key: env.ELEVENLABS_API_KEY,
            voiceId: env.ELEVENLABS_VOICE_ID,
            model: env.LOCALDOT_ELEVENLABS_MODEL || ELEVENLABS_MODEL,
          }
        : null,
    limits: {
      azure: limit("LOCALDOT_AZURE_CHARS_PER_MONTH", DEFAULT_LIMITS.azure),
      elevenlabs: limit("LOCALDOT_ELEVENLABS_CHARS_PER_MONTH", DEFAULT_LIMITS.elevenlabs),
    },
  };
}
