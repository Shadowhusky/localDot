import { useEffect, useRef } from "react";
import { markdownToSpeech } from "../agent/markdown.ts";
import type { AgentMessage } from "../agent/model.ts";
import { isListening, onListening } from "./listening.ts";

// Longer replies are read up to a sentence end near here; the rest stays in the thread.
const LONGEST = 1200;
const VOICES_MS = 1500;

// The language a reply is written in, for its voice: its own script where it has one, else the
// language the user talks in, unless that one is written in another script.
export function replyLanguage(text: string, fallback: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Han}/u.test(text)) return fallback.startsWith("zh") ? fallback : "zh-CN";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  return /^(zh|ja|ko)\b/.test(fallback) ? "en-US" : fallback;
}

// A voice of this device's own for the language. A voice that sends the text to a service is
// never used, so a reply never leaves the device to be read.
export function systemVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | undefined {
  const own = voices.filter((voice) => voice.localService);
  const tag = (voice: SpeechSynthesisVoice) => voice.lang.replace("_", "-").toLowerCase();
  const exact = own.filter((voice) => tag(voice) === language.toLowerCase());
  const base = language.split("-")[0]?.toLowerCase() ?? "";
  const pool = exact.length ? exact : own.filter((voice) => tag(voice).split("-")[0] === base);
  return pool.find((voice) => voice.default) ?? pool[0];
}

export function readable(markdown: string): string {
  const text = markdownToSpeech(markdown);
  if (text.length <= LONGEST) return text;
  const cut = text.slice(0, LONGEST);
  const end = Math.max(
    ...[". ", "! ", "? ", "。", "！", "？"].map((mark) => cut.lastIndexOf(mark)),
  );
  return end > LONGEST / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

const synth = () => (typeof speechSynthesis === "undefined" ? null : speechSynthesis);

function voices(speech: SpeechSynthesis): Promise<readonly SpeechSynthesisVoice[]> {
  const now = speech.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      speech.removeEventListener("voiceschanged", done);
      window.clearTimeout(timer);
      resolve(speech.getVoices());
    };
    const timer = window.setTimeout(done, VOICES_MS);
    speech.addEventListener("voiceschanged", done);
  });
}

async function say(speech: SpeechSynthesis, markdown: string, language: string) {
  const text = readable(markdown);
  if (!text) return;
  const lang = replyLanguage(text, language);
  const voice = systemVoice(await voices(speech), lang);
  if (!voice || isListening()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  speech.speak(utterance);
}

export interface ReadAloudInput {
  on: boolean;
  sessionId: string | null;
  // The task's history has arrived: what it holds was said before, and is not read.
  history: boolean;
  messages: ReadonlyMap<string, AgentMessage>;
  language: string;
}

// Settings → Voice → Read replies aloud: each reply dot finishes from now on, in this device's own
// voice. Talking to dot, turning it off or leaving stops it.
export function useReadAloud({ on, sessionId, history, messages, language }: ReadAloudInput) {
  const heard = useRef<{ session: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!on) synth()?.cancel();
  }, [on]);
  useEffect(() => {
    const stop = onListening(() => {
      if (isListening()) synth()?.cancel();
    });
    return () => {
      stop();
      synth()?.cancel();
    };
  }, []);
  useEffect(() => {
    if (!history || !sessionId) return;
    const finished = [...messages.values()].filter(
      (message) => message.role === "assistant" && message.final,
    );
    if (heard.current?.session !== sessionId) {
      heard.current = { session: sessionId, ids: new Set(finished.map((message) => message.id)) };
      return;
    }
    const speech = synth();
    for (const message of finished) {
      if (heard.current.ids.has(message.id)) continue;
      heard.current.ids.add(message.id);
      if (on && speech) void say(speech, message.text, language);
    }
  }, [on, sessionId, history, messages, language]);
}
