import type { Viseme } from "@localdot/avatar";
import type { Lang } from "./lang.ts";

export const SAMPLE_RATE = 24_000;
export const MIC_SAMPLE_RATE = 16_000;
export const FRAME_HEADER_BYTES = 8;
export const MAX_SENTENCE_CHARS = 400;

export type VoiceKind = "pack" | "stock" | "azure" | "elevenlabs" | "none";
export type TtsErrorCode =
  | "bad_request"
  | "too_long"
  | "unavailable"
  | "synthesis_failed"
  | "align_failed";
export type NoticeCode = "voice_offline" | "cloud_fallback" | "cloud_failed" | "budget_reached";

export type TtsClientMessage =
  | { type: "say"; id: number; text: string; lang: Lang }
  | { type: "cancel" };

export type TtsServerMessage =
  | { type: "ready"; voice: VoiceKind }
  | { type: "track"; id: number; lang: Lang; visemes: Viseme[] }
  | { type: "end"; id: number; samples: number }
  | { type: "error"; id: number | null; code: TtsErrorCode; message: string }
  | { type: "notice"; code: NoticeCode; message: string };

export type SttMode = "ptt" | "handsfree";
export type SttClientMessage = { type: "listen"; mode: SttMode } | { type: "release" };
export type SttErrorCode = "bad_request" | "unavailable" | "recognition_failed";
export type SttServerMessage =
  | { type: "ready" }
  | { type: "speech_started"; utterance: number }
  | { type: "partial"; utterance: number; text: string }
  | { type: "final"; utterance: number; text: string; lang: Lang | null }
  | { type: "end"; utterance: number; text: string; lang: Lang | null }
  | { type: "error"; code: SttErrorCode; message: string };

export interface AudioFrame {
  id: number;
  seq: number;
  pcm: Int16Array;
}

// Binary frame: u32 sentence id, u32 chunk index, then little-endian int16 mono PCM at 24 kHz.
export function encodeAudioFrame(
  id: number,
  seq: number,
  pcm: Int16Array,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, id, true);
  view.setUint32(4, seq, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(FRAME_HEADER_BYTES + i * 2, pcm[i] ?? 0, true);
  return bytes;
}

export function decodeAudioFrame(bytes: Uint8Array): AudioFrame | null {
  if (bytes.length < FRAME_HEADER_BYTES || (bytes.length - FRAME_HEADER_BYTES) % 2 !== 0)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array((bytes.length - FRAME_HEADER_BYTES) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(FRAME_HEADER_BYTES + i * 2, true);
  return { id: view.getUint32(0, true), seq: view.getUint32(4, true), pcm };
}

const LANGS = new Set<unknown>(["zh", "en", "ja"]);
const SHAPES = new Set<unknown>(["A", "I", "U", "E", "O", "N", "rest"]);
const VOICES = new Set<unknown>(["pack", "stock", "azure", "elevenlabs", "none"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isViseme = (v: unknown): v is Viseme =>
  isRecord(v) && Number.isFinite(v.t) && SHAPES.has(v.shape);

export function parseTtsServerMessage(text: string): TtsServerMessage | null {
  const m = parseRecord(text);
  if (!m) return null;
  switch (m.type) {
    case "ready":
      return VOICES.has(m.voice) ? { type: "ready", voice: m.voice as VoiceKind } : null;
    case "track":
      return isId(m.id) &&
        LANGS.has(m.lang) &&
        Array.isArray(m.visemes) &&
        m.visemes.every(isViseme)
        ? { type: "track", id: m.id, lang: m.lang as Lang, visemes: m.visemes as Viseme[] }
        : null;
    case "end":
      return isId(m.id) && isId(m.samples) ? { type: "end", id: m.id, samples: m.samples } : null;
    case "error":
      return (m.id === null || isId(m.id)) && typeof m.code === "string"
        ? {
            type: "error",
            id: m.id,
            code: m.code as TtsErrorCode,
            message: typeof m.message === "string" ? m.message : "",
          }
        : null;
    case "notice":
      return typeof m.code === "string"
        ? {
            type: "notice",
            code: m.code as NoticeCode,
            message: typeof m.message === "string" ? m.message : "",
          }
        : null;
    default:
      return null;
  }
}

export function parseSttServerMessage(text: string): SttServerMessage | null {
  const m = parseRecord(text);
  if (!m) return null;
  const lang = LANGS.has(m.lang) ? (m.lang as Lang) : null;
  const words = typeof m.text === "string" ? m.text : "";
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "speech_started":
      return isId(m.utterance) ? { type: "speech_started", utterance: m.utterance } : null;
    case "partial":
      return isId(m.utterance) ? { type: "partial", utterance: m.utterance, text: words } : null;
    case "final":
    case "end":
      return isId(m.utterance) ? { type: m.type, utterance: m.utterance, text: words, lang } : null;
    case "error":
      return typeof m.code === "string"
        ? {
            type: "error",
            code: m.code as SttErrorCode,
            message: typeof m.message === "string" ? m.message : "",
          }
        : null;
    default:
      return null;
  }
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
