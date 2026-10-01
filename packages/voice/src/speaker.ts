import { detectLang, type Lang } from "./lang.ts";
import type { VoicePlayer } from "./player.ts";
import { SentenceSplitter } from "./sentences.ts";
import type {
  AudioFrame,
  NoticeCode,
  TtsClientMessage,
  TtsErrorCode,
  TtsServerMessage,
  VoiceKind,
} from "./wire.ts";

export interface SpeakerEvents {
  sentence?(id: number, text: string, lang: Lang): void;
  error?(id: number | null, code: TtsErrorCode, message: string): void;
  notice?(code: NoticeCode, message: string): void;
  voice?(kind: VoiceKind): void;
}

export interface Reply {
  push(delta: string): void;
  end(): void;
}

// Turns reply text into sentences for the voice route and feeds what comes back to the player.
export class Speaker {
  readonly #player: VoicePlayer;
  readonly #send: (message: TtsClientMessage) => boolean;
  readonly #events: SpeakerEvents;
  #nextId = 1;
  // stop() starts a new generation; a reply from an older one stays silent however it streams on.
  #generation = 0;

  constructor(
    player: VoicePlayer,
    send: (message: TtsClientMessage) => boolean,
    events: SpeakerEvents = {},
  ) {
    this.#player = player;
    this.#send = send;
    this.#events = events;
  }

  reply(hint?: Lang): Reply {
    const generation = this.#generation;
    const splitter = new SentenceSplitter();
    const live = () => generation === this.#generation;
    const speak = (sentences: string[]) => {
      for (const text of sentences) this.#sentence(text, hint);
    };
    return {
      push: (delta) => {
        if (live()) speak(splitter.push(delta));
      },
      end: () => {
        if (live()) speak(splitter.flush());
      },
    };
  }

  say(text: string, hint?: Lang): void {
    const reply = this.reply(hint);
    reply.push(text);
    reply.end();
  }

  stop(): void {
    this.#generation++;
    this.#player.stop();
    this.#send({ type: "cancel" });
  }

  audio(frame: AudioFrame): void {
    this.#player.audio(frame.id, frame.pcm);
  }

  message(message: TtsServerMessage): void {
    switch (message.type) {
      case "track":
        this.#player.track(message.id, message.visemes);
        break;
      case "end":
        this.#player.end(message.id);
        break;
      case "error":
        // A failed sentence gets no end from voiced; ending it rests the mouth and lets it go.
        if (message.id !== null) this.#player.end(message.id);
        this.#events.error?.(message.id, message.code, message.message);
        break;
      case "notice":
        this.#events.notice?.(message.code, message.message);
        break;
      case "ready":
        this.#events.voice?.(message.voice);
        break;
    }
  }

  #sentence(piece: string, hint?: Lang): void {
    // voiced checks MAX_SENTENCE_CHARS before it collapses whitespace, so collapse it here first.
    const text = piece.replace(/\s+/g, " ");
    const id = this.#nextId++;
    const lang = detectLang(text, hint);
    this.#player.begin(id, lang);
    this.#events.sentence?.(id, text, lang);
    if (!this.#send({ type: "say", id, text, lang })) {
      this.#player.end(id);
      this.#events.error?.(id, "unavailable", "voice offline");
    }
  }
}
