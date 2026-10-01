import type { AvatarController, SpeechTrack } from "@localdot/avatar";
import {
  decodeAudioFrame,
  detectLang,
  parseTtsServerMessage,
  Speaker,
  VoicePlayer,
  VoiceSocket,
} from "@localdot/voice";
import { type VoiceStatus, voiceNote } from "./voice-notes.ts";

export interface VoiceStats {
  firstAudioMs: number[];
  speaking: boolean;
  shapes: string[];
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// The harness's voice loop: typed text in, her voice and mouth out.
export function mountVoice(controller: AvatarController): void {
  const note = byId<HTMLElement>("voice-note");
  const sayText = byId<HTMLTextAreaElement>("say-text");
  const ctx = new AudioContext();
  let lastTrack: SpeechTrack | null = null;
  const player = new VoicePlayer(ctx, {
    speak: (track) => {
      if (track) lastTrack = track;
      controller.speak(track);
    },
  });
  const status: VoiceStatus = { online: false, voice: null, notice: null };
  const render = () => {
    note.textContent = voiceNote(status);
  };
  const sentAt = new Map<number, number>();
  const firstOfReply: number[] = [];
  let replyStarting = false;

  const speaker = new Speaker(player, (message) => tts.send(JSON.stringify(message)), {
    sentence: (id) => {
      sentAt.set(id, performance.now());
      if (replyStarting) firstOfReply.push(id);
      replyStarting = false;
    },
    voice: (kind) => {
      status.voice = kind;
      status.notice = null;
      render();
    },
    notice: (code) => {
      status.notice = code;
      render();
    },
  });
  const tts = new VoiceSocket(`ws://${location.host}/voice/tts`, {
    text: (data) => {
      const message = parseTtsServerMessage(data);
      if (message) speaker.message(message);
    },
    binary: (bytes) => {
      const frame = decodeAudioFrame(bytes);
      if (!frame) return;
      // Sound means a voice is back; a cloud notice still names the voice that is speaking.
      if (status.notice === "voice_offline") {
        status.notice = null;
        render();
      }
      speaker.audio(frame);
    },
    status: (online) => {
      status.online = online;
      render();
    },
  });
  tts.connect();
  render();

  const say = (text: string) => {
    void player.unlock();
    replyStarting = true;
    // Kanji-only Japanese looks Chinese, so the language of the whole text settles it.
    speaker.say(text, detectLang(text));
  };
  byId<HTMLFormElement>("say-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (sayText.value.trim()) say(sayText.value);
  });
  byId<HTMLButtonElement>("stop").addEventListener("click", () => speaker.stop());

  const stats = (): VoiceStats => ({
    firstAudioMs: firstOfReply.flatMap((id) => {
      const heardAt = player.firstAudioAt(id);
      const sent = sentAt.get(id);
      return heardAt !== undefined && sent !== undefined ? [heardAt - sent] : [];
    }),
    speaking: player.speaking,
    shapes: [...new Set(lastTrack?.visemes.map((v) => v.shape) ?? [])].sort(),
  });
  Object.assign(window, {
    __voice: { say, stop: () => speaker.stop(), online: () => status.online, stats },
  });
}
