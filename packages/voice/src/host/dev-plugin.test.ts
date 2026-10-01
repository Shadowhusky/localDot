import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { TtsServerMessage } from "../wire.ts";
import { createTtsRouter, voiceDevPlugin } from "./dev-plugin.ts";
import { FakeChild } from "./fake-voiced.ts";
import { type Budget, UNLIMITED } from "./router.ts";
import { voiceSettingsFromEnv } from "./settings.ts";
import type { SpawnLike } from "./supervisor.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function harness(env: NodeJS.ProcessEnv) {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  const spawn: SpawnLike = (_command, args, options) => {
    const child = new FakeChild();
    spawned.push({ args, env: options.env, child });
    return child;
  };
  // Like Vite, the server answers ordinary requests; only /voice upgrades belong to the plugin.
  const server = createServer((_request, response) => response.writeHead(426).end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  voiceDevPlugin({ port, voicedDir: "/repo/apps/voiced", env, spawn }).configureServer({
    httpServer: server,
  });
  return { port, spawned, server };
}

const open = (port: number, origin: string) =>
  new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/voice/tts`, ["localdot.v1"], { origin });
    socket.once("open", () => {
      socket.terminate();
      resolve("open");
    });
    socket.once("error", (error) => resolve(error.message));
  });

// The page's side of one sentence: what comes back within a second.
const sayHi = (port: number) =>
  new Promise<unknown[]>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/voice/tts`, ["localdot.v1"], {
      origin: `http://127.0.0.1:${port}`,
    });
    const messages: unknown[] = [];
    const done = () => {
      clearTimeout(deadline);
      socket.terminate();
      resolve(messages);
    };
    const deadline = setTimeout(done, 1000);
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === 2) done();
    });
    socket.once("open", () =>
      socket.send(JSON.stringify({ type: "say", id: 1, text: "Hi.", lang: "en" })),
    );
    socket.once("error", reject);
  });

describe("voiceDevPlugin", () => {
  const home = () => mkdtempSync(join(tmpdir(), "voice-home-"));

  it("starts voiced with uv on the page's first voice connection, with the pack voice", async () => {
    const { port, spawned } = await harness({
      PATH: "/usr/bin",
      LOCALDOT_VOICE_DIR: "/packs/voice",
      LOCALDOT_HOME: home(),
    });
    expect(spawned).toHaveLength(0);
    expect(await open(port, `http://127.0.0.1:${port}`)).toBe("open");
    expect(spawned[0]?.args).toEqual([
      "run",
      "--project",
      "/repo/apps/voiced",
      "--frozen",
      "voiced",
    ]);
    expect(spawned[0]?.env.LOCALDOT_VOICE_DIR).toBe("/packs/voice");
  });

  it("refuses other origins without starting anything", async () => {
    const { port, spawned } = await harness({ LOCALDOT_HOME: home() });
    expect(await open(port, "http://evil.example")).toMatch(/403/);
    expect(spawned).toHaveLength(0);
  });

  it("stops voiced when the dev server closes", async () => {
    const { port, spawned, server } = await harness({ LOCALDOT_HOME: home() });
    await open(port, `http://localhost:${port}`);
    servers.splice(servers.indexOf(server), 1);
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned[0]?.child.exitCode).toBe(0);
  });

  it("stays out of the way when voice is off", async () => {
    const { port, spawned } = await harness({ LOCALDOT_VOICE: "off", LOCALDOT_HOME: home() });
    expect(await open(port, `http://127.0.0.1:${port}`)).toMatch(/426/);
    expect(spawned).toHaveLength(0);
  });

  it("starts nothing when voice output is off, and tells the page there is no voice", async () => {
    const { port, spawned } = await harness({
      LOCALDOT_VOICE_OUTPUT: "off",
      LOCALDOT_HOME: home(),
    });
    expect(await sayHi(port)).toEqual([
      { type: "ready", voice: "none" },
      { type: "error", id: 1, code: "unavailable", message: "no voice is available" },
    ]);
    expect(spawned).toHaveLength(0);
  });
});

describe("createTtsRouter", () => {
  const collect = () => {
    const messages: TtsServerMessage[] = [];
    return {
      messages,
      out: { frame: () => {}, message: (m: TtsServerMessage) => messages.push(m) },
    };
  };

  it("answers every sentence as unavailable when voice output is off", async () => {
    const { messages, out } = collect();
    const router = createTtsRouter(
      voiceSettingsFromEnv({ LOCALDOT_VOICE_OUTPUT: "off" }),
      async () => null,
      out,
      UNLIMITED,
    );
    router.handle({ type: "say", id: 1, text: "Hi.", lang: "en" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([
      { type: "ready", voice: "none" },
      { type: "error", id: 1, code: "unavailable", message: "no voice is available" },
    ]);
  });

  it("skips an opted-in cloud voice that has no credentials, without calling out", async () => {
    const { messages, out } = collect();
    const router = createTtsRouter(
      voiceSettingsFromEnv({ LOCALDOT_VOICE_OUTPUT: "azure", LOCALDOT_VOICE_FALLBACK: "azure" }),
      async () => null,
      out,
      UNLIMITED,
    );
    router.handle({ type: "say", id: 1, text: "Hi.", lang: "en" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.map((m) => (m.type === "notice" ? m.code : m.type))).toEqual([
      "voice_offline",
      "error",
    ]);
  });

  it("names a configured cloud voice to the page without waking voiced", () => {
    const NO_CLOUD: Budget = { allows: () => false, record: () => {} };
    for (const [output, keys] of [
      ["azure", { AZURE_SPEECH_KEY: "a-key", AZURE_SPEECH_REGION: "eastus" }],
      ["elevenlabs", { ELEVENLABS_API_KEY: "e-key", ELEVENLABS_VOICE_ID: "v1" }],
    ] as const) {
      const { messages, out } = collect();
      const endpoint = vi.fn(async () => null);
      createTtsRouter(
        voiceSettingsFromEnv({ LOCALDOT_VOICE_OUTPUT: output, ...keys }),
        endpoint,
        out,
        NO_CLOUD,
      ).close();
      expect(messages).toEqual([{ type: "ready", voice: output }]);
      expect(endpoint).not.toHaveBeenCalled();
    }
  });
});
