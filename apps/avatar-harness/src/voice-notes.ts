import type { NoticeCode, VoiceKind } from "@localdot/voice";

export interface VoiceStatus {
  online: boolean;
  voice: VoiceKind | null;
  notice: NoticeCode | null;
}

const VOICES: Record<VoiceKind, string> = {
  pack: "Voice: theme pack",
  stock: "Voice: stock (Vivian)",
  azure: "Voice: Azure",
  elevenlabs: "Voice: ElevenLabs",
  none: "Voice offline: replies stay as text.",
};

const NOTICES: Record<NoticeCode, string> = {
  voice_offline: "Voice offline: replies stay as text.",
  cloud_fallback: "Local voice unavailable: speaking with the cloud voice.",
  cloud_failed: "Cloud voice failed: back to the local voice.",
  budget_reached: "Cloud voice budget reached: using the local voice.",
};

export function voiceNote(status: VoiceStatus): string {
  if (!status.online) return NOTICES.voice_offline;
  if (status.notice) return NOTICES[status.notice];
  return status.voice ? VOICES[status.voice] : "Voice: connecting…";
}
