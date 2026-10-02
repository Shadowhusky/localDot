import type { AvatarController, SpeechTrack } from "@localdot/avatar";
import {
  decodeAudioFrame,
  FADE_OUT_S,
  Listener,
  type Mic,
  openMic,
  parseTtsServerMessage,
  replyLang,
  Speaker,
  type SttMode,
  VoicePlayer,
  VoiceSocket,
} from "@localdot/voice";
import { type VoiceStatus, voiceNote } from "./voice-notes.ts";

export interface VoiceStats {
  firstAudioMs: number[];
  speaking: boolean;
  shapes: string[];
  bargeInMs: number[];
  utterances: { text: string; lang: string | null }[];
}

// Her voice leaves the speakers for the output latency after its last sample is due, and the room
// carries it a little longer; half duplex keeps listening paused through both.
const ECHO_TAIL_MS = 250;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// The harness's voice loop: typed text in, her voice and mouth out; optional voice input.
export function mountVoice(controller: AvatarController): void {
  const note = byId<HTMLElement>("voice-note");
  const sayText = byId<HTMLTextAreaElement>("say-text");
  const micNote = byId<HTMLElement>("mic-note");
  const heard = byId<HTMLElement>("heard");
  const panel = byId<HTMLElement>("voice-input-panel");
  const toggle = byId<HTMLInputElement>("voice-input");
  const micButton = byId<HTMLButtonElement>("mic");
  const halfDuplex = byId<HTMLInputElement>("half-duplex");
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
  const bargeInMs: number[] = [];
  const utterances: VoiceStats["utterances"] = [];
  // Sentences sent and not yet ended: a reply still on its way counts as her speaking.
  const unfinished = new Set<number>();
  let replyStarting = false;

  const speaker = new Speaker(player, (message) => tts.send(JSON.stringify(message)), {
    sentence: (id) => {
      sentAt.set(id, performance.now());
      unfinished.add(id);
      if (replyStarting) firstOfReply.push(id);
      replyStarting = false;
    },
    error: (id) => {
      if (id !== null) unfinished.delete(id);
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
      if (!message) return;
      if (message.type === "end") unfinished.delete(message.id);
      speaker.message(message);
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
    speaker.say(text, replyLang(text));
  };
  const stop = () => {
    speaker.stop();
    unfinished.clear();
  };
  byId<HTMLFormElement>("say-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (sayText.value.trim()) say(sayText.value);
  });
  byId<HTMLButtonElement>("stop").addEventListener("click", stop);

  const outputLatencyMs = () => (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
  const bargeIn = () => {
    const audible = player.speaking;
    if (!audible && unfinished.size === 0) return;
    const started = performance.now();
    stop();
    if (audible) {
      bargeInMs.push(performance.now() - started + FADE_OUT_S * 1000 + outputLatencyMs());
    }
  };
  let herVoiceUntil = 0;
  const herVoiceAudible = () => {
    if (player.speaking) herVoiceUntil = performance.now() + outputLatencyMs() + ECHO_TAIL_MS;
    return performance.now() < herVoiceUntil;
  };
  const mode = (): SttMode =>
    document.querySelector<HTMLInputElement>('input[name="voice-mode"]:checked')?.value ===
    "handsfree"
      ? "handsfree"
      : "ptt";
  let mic: Mic | null = null;
  let held = false;
  let inputOnline = false;
  let whenOnline: (() => void) | null = null;
  // Each flip of the switch; a flip still waiting on the browser gives way to a later one.
  let flips = 0;
  let showingError = false;
  const show = (text: string, error = false) => {
    heard.textContent = text;
    showingError = error;
  };
  const letGo = () => {
    held = false;
    delete micButton.dataset.held;
  };
  const listener = new Listener(
    `ws://${location.host}/voice/stt`,
    {
      status: (online) => {
        inputOnline = online;
        if (!online) {
          if (held) {
            letGo();
            show("Voice input lost its connection. Hold to talk again in a moment.", true);
          }
          return;
        }
        whenOnline?.();
        if (mic && mode() === "handsfree") listener.listen("handsfree");
      },
      ready: () => {
        if (showingError) show("");
      },
      speechStarted: bargeIn,
      partial: (text) => show(text),
      final: (text) => show(text),
      utterance: (text, lang) => {
        show(`You said: ${text}`);
        utterances.push({ text, lang });
      },
      error: (_code, message) => show(message, true),
    },
    // Push-to-talk audio leaves the page only while the key is held.
    {
      gate: () => (held || mode() === "handsfree") && !(halfDuplex.checked && herVoiceAudible()),
    },
  );

  const turnOff = () => {
    mic?.close();
    mic = null;
    letGo();
    listener.close();
    panel.hidden = true;
    toggle.checked = false;
    show("");
  };
  const voiceInput = async (on: boolean) => {
    const flip = ++flips;
    micNote.textContent = "";
    if (!on) {
      turnOff();
      return;
    }
    if (mic) return;
    const opened = await openMic((pcm) => listener.frame(pcm));
    if (flip !== flips) {
      if (opened.ok) opened.mic.close();
      return;
    }
    if (!opened.ok) {
      toggle.checked = false;
      micNote.textContent = opened.message;
      return;
    }
    mic = opened.mic;
    toggle.checked = true;
    panel.hidden = false;
    listener.open();
    if (!inputOnline)
      await new Promise<void>((resolve) => {
        whenOnline = resolve;
        setTimeout(resolve, 5000);
      });
    whenOnline = null;
  };
  toggle.addEventListener("change", () => void voiceInput(toggle.checked));
  const modeChanged = () => {
    letGo();
    if (!mic) return;
    if (mode() === "handsfree") listener.listen("handsfree");
    else listener.release();
  };
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="voice-mode"]')) {
    radio.addEventListener("change", modeChanged);
  }

  const press = () => {
    if (!mic || mode() !== "ptt" || held) return;
    if (!listener.listen("ptt")) {
      show("Voice input is still connecting. Try again in a moment.", true);
      return;
    }
    held = true;
    // The user takes the floor: what is left of her voice no longer holds their words back.
    herVoiceUntil = 0;
    bargeIn();
    micButton.dataset.held = "true";
  };
  const release = () => {
    if (!held) return;
    letGo();
    listener.release();
  };
  micButton.addEventListener("pointerdown", press);
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
    micButton.addEventListener(type, release);
  }
  // Hold the right Option key to talk; it types nothing on its own.
  addEventListener("keydown", (event) => {
    if (event.code === "AltRight" && !event.repeat) press();
  });
  addEventListener("keyup", (event) => {
    if (event.code === "AltRight") release();
  });
  // A key let go while another window has focus never reaches the page.
  addEventListener("blur", release);

  const stats = (): VoiceStats => ({
    firstAudioMs: firstOfReply.flatMap((id) => {
      const heardAt = player.firstAudioAt(id);
      const sent = sentAt.get(id);
      return heardAt !== undefined && sent !== undefined ? [heardAt - sent] : [];
    }),
    speaking: player.speaking,
    shapes: [...new Set(lastTrack?.visemes.map((v) => v.shape) ?? [])].sort(),
    bargeInMs: [...bargeInMs],
    utterances: [...utterances],
  });
  Object.assign(window, {
    __voice: {
      say,
      stop,
      online: () => status.online,
      stats,
      talk: async (ms: number) => {
        press();
        await new Promise((resolve) => setTimeout(resolve, ms));
        release();
      },
      voiceInput: async (inputMode: SttMode) => {
        const radio = document.querySelector<HTMLInputElement>(
          `input[name="voice-mode"][value="${inputMode}"]`,
        );
        if (radio && !radio.checked) {
          radio.checked = true;
          modeChanged();
        }
        await voiceInput(true);
      },
    },
  });
}
