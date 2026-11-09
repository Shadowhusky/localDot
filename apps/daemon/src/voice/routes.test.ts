import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { RemoteLinks } from "../remote/links.ts";
import { SPEECH_RATE, speechWav } from "./routes.ts";
import { SpeechBusyError, type Transcriber } from "./speech.ts";
import { SpeechInstallRefused } from "./speech-install.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const bearer = { authorization: `Bearer ${TOKEN}` };

function wav(samples: number, rate = SPEECH_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return out;
}

let home: string;
let speech: Transcriber | null;
let heard: { language: string | null; bytes: number }[];
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-voice-routes-"));
  heard = [];
  speech = {
    englishOnly: false,
    transcribe: async (audio, language) => {
      heard.push({ language, bytes: audio.length });
      return "hello dot";
    },
  };
  app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: new EventLog(home),
    voice: { speech: () => speech },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const post = (body: Uint8Array, query = "?lang=en", type = "audio/wav") =>
  app.request(url(`/api/voice/transcribe${query}`), {
    method: "POST",
    headers: { ...bearer, "content-type": type },
    body,
  });

describe("voice routes", () => {
  it("say whether this computer has a speech model, behind the token", async () => {
    expect((await app.request(url("/api/voice"))).status).toBe(401);
    expect(await (await app.request(url("/api/voice"), { headers: bearer })).json()).toEqual({
      onMac: { available: true, englishOnly: false },
    });
    speech = null;
    expect(await (await app.request(url("/api/voice"), { headers: bearer })).json()).toEqual({
      onMac: { available: false },
    });
  });

  it("turn a recording into text", async () => {
    const response = await post(wav(1600));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello dot" });
    expect(heard).toEqual([{ language: "en", bytes: 44 + 3200 }]);
  });

  it("refuse what is not the expected recording", async () => {
    expect((await post(wav(1600), "?lang=en", "audio/webm")).status).toBe(415);
    expect((await post(wav(1600, 48_000))).status).toBe(400);
    expect((await post(wav(1600), "?lang=../x")).status).toBe(400);
    expect((await post(new Uint8Array(5 * 1024 * 1024))).status).toBe(413);
    expect(heard).toEqual([]);
  });

  it("explain a missing, English-only or busy model", async () => {
    speech = { englishOnly: true, transcribe: async () => "" };
    expect((await post(wav(10), "?lang=ja")).status).toBe(422);
    speech = {
      englishOnly: false,
      transcribe: async () => {
        throw new SpeechBusyError();
      },
    };
    expect((await post(wav(10))).status).toBe(409);
    speech = null;
    expect((await post(wav(10))).status).toBe(404);
  });

  it("check the header the browser writes", () => {
    expect(speechWav(wav(8))).toBe(true);
    const short = wav(8).subarray(0, 50);
    expect(speechWav(short)).toBe(false);
  });
});

describe("installing speech on this computer", () => {
  const GUEST = "g".repeat(43);
  let starts: string[];
  let cancels: number;
  let removes: number;
  let refused: boolean;
  let guestApp: ReturnType<typeof createApp>;
  const status = { supported: true, job: null };
  const install = {
    status: () => status as never,
    start: (tier: string) => {
      if (refused) throw new SpeechInstallRefused("Another speech model is already downloading.");
      starts.push(tier);
    },
    cancel: async () => {
      cancels += 1;
    },
    remove: async () => {
      removes += 1;
    },
  };
  beforeEach(() => {
    starts = [];
    cancels = 0;
    removes = 0;
    refused = false;
    const links = {
      permits: new RemoteLinks(home).permits.bind({ active: () => ({ id: "a" }) }),
      onRevoke: () => () => {},
      sessions: () => [],
    };
    guestApp = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: new EventLog(home),
      voice: { speech: () => null, install },
      remoteAccess: {
        links,
        authenticate: (given?: string) => (given === GUEST ? { id: "a", replay: true } : null),
      } as never,
    });
  });

  const owner = { ...bearer, "content-type": "application/json" };
  const ask = (path: string, method: string, headers: Record<string, string>, body?: string) =>
    guestApp.request(url(path), { method, headers, body });

  it("reads where things stand without starting anything", async () => {
    const reply = await ask("/api/voice/install", "GET", bearer);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual(status);
    expect(starts).toEqual([]);
  });

  it("starts only when pressed, with a known tier", async () => {
    const reply = await ask("/api/voice/install", "POST", owner, JSON.stringify({ tier: "light" }));
    expect(reply.status).toBe(202);
    expect(starts).toEqual(["light"]);
    expect((await ask("/api/voice/install", "POST", owner, "{}")).status).toBe(400);
    expect(
      (await ask("/api/voice/install", "POST", owner, JSON.stringify({ tier: "huge" }))).status,
    ).toBe(400);
    expect(
      (
        await ask(
          "/api/voice/install",
          "POST",
          owner,
          JSON.stringify({ tier: "languages", url: "x" }),
        )
      ).status,
    ).toBe(400);
    expect(starts).toEqual(["light"]);
  });

  it("says when another install holds the turn", async () => {
    refused = true;
    const reply = await ask(
      "/api/voice/install",
      "POST",
      owner,
      JSON.stringify({ tier: "languages" }),
    );
    expect(reply.status).toBe(409);
    expect(await reply.text()).toMatch(/already downloading/);
  });

  it("cancels and removes", async () => {
    expect((await ask("/api/voice/install/cancel", "POST", bearer)).status).toBe(200);
    expect(cancels).toBe(1);
    expect((await ask("/api/voice/install", "DELETE", bearer)).status).toBe(200);
    expect(removes).toBe(1);
  });

  it("needs the owner's token", async () => {
    expect((await ask("/api/voice/install", "GET", {})).status).toBe(401);
    expect((await ask("/api/voice/install", "POST", {}, "{}")).status).toBe(401);
    expect((await ask("/api/voice/install/cancel", "POST", {})).status).toBe(401);
    expect((await ask("/api/voice/install", "DELETE", {})).status).toBe(401);
  });

  it("refuses a shared link's guest at every door", async () => {
    const guest = { authorization: `Bearer ${GUEST}`, "content-type": "application/json" };
    expect((await ask("/api/voice/install", "GET", guest)).status).toBe(403);
    expect(
      (await ask("/api/voice/install", "POST", guest, JSON.stringify({ tier: "light" }))).status,
    ).toBe(403);
    expect((await ask("/api/voice/install/cancel", "POST", guest)).status).toBe(403);
    expect((await ask("/api/voice/install", "DELETE", guest)).status).toBe(403);
    expect(starts).toEqual([]);
    expect(cancels).toBe(0);
    expect(removes).toBe(0);
  });

  it("leaves transcription with no route once a guest asks", async () => {
    const guest = { authorization: `Bearer ${GUEST}`, "content-type": "audio/wav" };
    expect((await ask("/api/voice", "GET", guest)).status).toBe(403);
    expect((await ask("/api/voice/transcribe", "POST", guest)).status).toBe(403);
  });
});

describe("what the page is told about the installed model", () => {
  it("says which languages it hears", async () => {
    speech = { englishOnly: false, languages: ["zh", "en"], transcribe: async () => "" };
    expect(await (await app.request(url("/api/voice"), { headers: bearer })).json()).toEqual({
      onMac: { available: true, englishOnly: false, languages: ["zh", "en"] },
    });
  });

  it("refuses a language the model can't hear, so the browser's own speech is used", async () => {
    speech = { englishOnly: false, languages: ["zh", "en"], transcribe: async () => "words" };
    expect((await post(wav(1600), "?lang=ja")).status).toBe(422);
    expect((await post(wav(1600), "?lang=zh")).status).toBe(200);
  });
});
