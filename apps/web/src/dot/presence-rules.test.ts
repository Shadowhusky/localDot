import { describe, expect, it } from "vitest";
import { type PresenceInput, presencePlace } from "./presence-rules.ts";

const LIVE: PresenceInput = {
  showDot: true,
  curtain: false,
  replaying: false,
  keyboard: false,
};

describe("where the one live dot is", () => {
  it("sits on the curtain while it is up and docks beside the stage once the computer is on", () => {
    // The curtain is up from the first frame, with dot waking on it until the computer is known.
    expect(presencePlace({ ...LIVE, curtain: true })).toBe("hero");
    expect(presencePlace(LIVE)).toBe("dock");
  });

  it("moves into the island while a phone's keyboard has collapsed the band", () => {
    expect(presencePlace({ ...LIVE, keyboard: true })).toBe("badge");
    expect(presencePlace({ ...LIVE, keyboard: true, curtain: true })).toBe("hero");
  });

  it("docks in Replay whatever the curtain or the keyboard does, and is nowhere when it is off", () => {
    expect(presencePlace({ ...LIVE, replaying: true, curtain: true, keyboard: true })).toBe("dock");
    for (const curtain of [false, true])
      for (const keyboard of [false, true])
        expect(presencePlace({ ...LIVE, showDot: false, curtain, keyboard })).toBeNull();
  });

  it("sits above first-run setup, over whatever the app would show, unless it is off", () => {
    for (const curtain of [false, true])
      for (const replaying of [false, true])
        expect(presencePlace({ ...LIVE, setup: true, curtain, replaying })).toBe("intro");
    expect(presencePlace({ ...LIVE, setup: true, showDot: false })).toBeNull();
  });
});
