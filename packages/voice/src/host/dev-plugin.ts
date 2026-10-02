import { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { AzureTts } from "./azure.ts";
import { UsageLedger } from "./budget.ts";
import { ElevenLabsTts, voicedVisemes } from "./elevenlabs.ts";
import { attachVoiceGateway, isLocalPage } from "./gateway.ts";
import { LocalTts, type VoicedEndpoint } from "./local.ts";
import {
  type Budget,
  type ProviderKind,
  providerOrder,
  type TtsOutput,
  type TtsProvider,
  TtsRouter,
} from "./router.ts";
import { type VoiceSettings, voiceSettingsFromEnv } from "./settings.ts";
import { relaySpeechInput } from "./stt-relay.ts";
import { type SpawnLike, VoicedSupervisor } from "./supervisor.ts";

// voiced imports its model libraries on start, so the first sentence may wait this long for it.
export const READY_WAIT_MS = 20_000;

export interface VoiceDevOptions {
  port: number;
  voicedDir: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
}

export function voicedCommand(voicedDir: string): string[] {
  return ["uv", "run", "--project", voicedDir, "--frozen", "voiced"];
}

export function createTtsRouter(
  settings: VoiceSettings,
  endpoint: () => Promise<VoicedEndpoint | null>,
  out: TtsOutput,
  budget: Budget,
): TtsRouter {
  const { azure, elevenlabs } = settings;
  const local = new LocalTts(endpoint, out);
  const providers: Partial<Record<ProviderKind, TtsProvider>> = {
    local,
    ...(azure ? { azure: new AzureTts(() => azure, out) } : {}),
    ...(elevenlabs
      ? { elevenlabs: new ElevenLabsTts(() => elevenlabs, out, voicedVisemes(endpoint)) }
      : {}),
  };
  const order = providerOrder(settings.output, settings.fallback);
  const first = order.find((kind) => providers[kind]);
  // voiced's greeting names the local voice (pack or stock), so connecting early tells the page
  // which voice will speak; any other first voice, or none, is named here instead.
  if (first === "local") void local.warm();
  else out.message({ type: "ready", voice: first ?? "none" });
  return new TtsRouter({ order, providers, out, budget });
}

// Plays the daemon's part for the avatar harness: starts voiced on first use and serves /voice.
export function voiceDevPlugin(options: VoiceDevOptions) {
  return {
    name: "localdot-voice",
    configureServer(server: { httpServer: unknown }): void {
      const http = server.httpServer;
      const env = options.env ?? process.env;
      if (!(http instanceof Server) || env.LOCALDOT_VOICE === "off") return;
      const supervisor = new VoicedSupervisor({
        command: voicedCommand(options.voicedDir),
        env,
        ...(env.LOCALDOT_VOICE_DIR ? { voiceDir: env.LOCALDOT_VOICE_DIR } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
      });
      const endpoint = async (): Promise<VoicedEndpoint | null> =>
        (await supervisor.whenReady(READY_WAIT_MS))
          ? { host: supervisor.host, token: supervisor.token }
          : null;
      const settings = voiceSettingsFromEnv(env);
      const home = env.LOCALDOT_HOME ?? join(homedir(), ".localdot");
      const ledger = new UsageLedger(join(home, "voice-usage.json"), settings.limits);
      const detach = attachVoiceGateway(http, {
        authorize: (request) => isLocalPage(request, options.port),
        tts: (out) => {
          if (settings.output !== "off") supervisor.start();
          return createTtsRouter(settings, endpoint, out, ledger);
        },
        stt: (browser) => {
          supervisor.start();
          relaySpeechInput(browser, endpoint);
        },
      });
      http.once("close", () => {
        detach();
        void supervisor.stop();
      });
    },
  };
}
