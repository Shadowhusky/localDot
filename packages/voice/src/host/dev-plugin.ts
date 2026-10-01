import { Server } from "node:http";
import { attachVoiceGateway, isLocalPage } from "./gateway.ts";
import { LocalTts, type VoicedEndpoint } from "./local.ts";
import {
  type OutputSetting,
  type ProviderKind,
  providerOrder,
  type TtsOutput,
  type TtsProvider,
  TtsRouter,
} from "./router.ts";
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
  output: OutputSetting,
  endpoint: () => Promise<VoicedEndpoint | null>,
  out: TtsOutput,
): TtsRouter {
  const local = new LocalTts(endpoint, out);
  const providers: Partial<Record<ProviderKind, TtsProvider>> = { local };
  const order = providerOrder(output, "none");
  const first = order.find((kind) => providers[kind]);
  // voiced's greeting names the local voice (pack or stock), so connecting early tells the page
  // which voice will speak; any other first voice, or none, is named here instead.
  if (first === "local") void local.warm();
  else out.message({ type: "ready", voice: first ?? "none" });
  return new TtsRouter({ order, providers, out });
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
      const output: OutputSetting = env.LOCALDOT_VOICE_OUTPUT === "off" ? "off" : "local";
      const detach = attachVoiceGateway(http, {
        authorize: (request) => isLocalPage(request, options.port),
        tts: (out) => {
          if (output !== "off") supervisor.start();
          return createTtsRouter(output, endpoint, out);
        },
      });
      http.once("close", () => {
        detach();
        void supervisor.stop();
      });
    },
  };
}
