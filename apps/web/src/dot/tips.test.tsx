// @vitest-environment jsdom
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bannedWords } from "../copy/banned.ts";
import { SettingsSheet } from "../settings/SettingsSheet.tsx";
import { SECTIONS, sectionTitle } from "../settings/sections.ts";
import { knownFixture } from "../settings/testing.ts";
import { tipText } from "./idle-line.ts";
import { GREETINGS, TIPS, type TipSignals } from "./tips.ts";

afterEach(cleanup);

const SIGNALS: TipSignals[] = [true, false].map((apple) => ({
  touch: false,
  apple,
  recordings: true,
  update: true,
  freshStart: true,
  openAtLogin: "off",
}));
const lines = [
  ...Object.values(GREETINGS).flat(),
  ...TIPS.flatMap((tip) => SIGNALS.map((signals) => tipText(tip, signals))),
];

describe("dot's idle lines", () => {
  it("keeps to dot's voice: plain, short, no shouting, no emoji, no internal words", () => {
    for (const line of lines) {
      expect(line, line).not.toMatch(/!/);
      expect(line, line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(bannedWords(line), line).toEqual([]);
      expect(line.length, line).toBeLessThanOrEqual(70);
      expect(line, line).toMatch(/^[A-Z“⌘/]/u);
      expect(line, line).toMatch(/[.?]$/);
    }
  });

  it("leaves a tip with a step room for it on a phone's two lines", () => {
    for (const tip of TIPS.filter((each) => each.action))
      for (const signals of SIGNALS)
        expect(tipText(tip, signals).length, tip.id).toBeLessThanOrEqual(60);
  });

  it("has a few greetings for each part of the day and one id per tip", () => {
    for (const part of Object.values(GREETINGS)) expect(part.length).toBeGreaterThanOrEqual(2);
    expect(new Set(TIPS.map((tip) => tip.id)).size).toBe(TIPS.length);
  });

  it("opens only what exists: each Settings step lands on a section that shows its feature", () => {
    const shown = render(
      <SettingsSheet
        open
        choices={{}}
        providers={[]}
        keys={[]}
        keyLayer="online"
        catalog="ready"
        dirty={false}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onKeys={vi.fn()}
        save={{ enabled: false, run: vi.fn() }}
        autonomy={DEFAULT_AUTONOMY}
        savedAutonomy={DEFAULT_AUTONOMY}
        onAutonomy={vi.fn()}
        purposeCheck={{ on: false, change: vi.fn(), judge: "fast" }}
        knowledge={{
          skills: [],
          skillsPhase: "ready",
          memory: { user: "", memory: "" },
          memoryPhase: "ready",
          reloadSkills: vi.fn(),
          rereadMemory: vi.fn(),
        }}
        known={knownFixture()}
        update={{ available: true, busy: false, error: null, run: vi.fn() }}
        freshStart={{ available: true, busy: false, error: null, run: vi.fn() }}
        stopAll={{ run: vi.fn(), running: false }}
        startAtLogin={{ state: "off", busy: false, set: vi.fn() }}
        onSetup={vi.fn()}
      />,
    );
    const ids = new Set(SECTIONS.map((section) => section.id));
    const steps = TIPS.flatMap((tip) => (tip.action ? [{ id: tip.id, action: tip.action }] : []));
    expect(steps.length).toBeGreaterThan(0);
    for (const { id, action } of steps) {
      expect(["settings", "replay", "routine"], id).toContain(action.opens);
      expect(["Open", "Try it"], id).toContain(action.label);
      if (action.opens !== "settings") continue;
      expect(ids.has(action.section), id).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: sectionTitle(action.section) }));
      const section = shown.container.ownerDocument.querySelector(
        `[data-section="${action.section}"]`,
      );
      expect(section?.textContent, id).toContain(action.finds);
    }
  });
});
