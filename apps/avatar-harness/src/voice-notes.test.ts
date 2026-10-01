import { describe, expect, it } from "vitest";
import { voiceNote } from "./voice-notes.ts";

describe("voiceNote", () => {
  it("says which voice speaks, and that replies stay as text when none can", () => {
    expect(voiceNote({ online: true, voice: "pack", notice: null })).toBe("Voice: theme pack");
    expect(voiceNote({ online: true, voice: "stock", notice: null })).toBe("Voice: stock (Vivian)");
    expect(voiceNote({ online: true, voice: null, notice: null })).toBe("Voice: connecting…");
    expect(voiceNote({ online: false, voice: "pack", notice: null })).toBe(
      "Voice offline: replies stay as text.",
    );
    expect(voiceNote({ online: true, voice: "stock", notice: "voice_offline" })).toBe(
      "Voice offline: replies stay as text.",
    );
    expect(voiceNote({ online: true, voice: "stock", notice: "budget_reached" })).toMatch(
      /budget reached/,
    );
  });
});
