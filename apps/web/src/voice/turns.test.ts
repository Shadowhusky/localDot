// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceError, type VoiceFailure } from "./capture.ts";
import type { Hearing, HearingEvents } from "./hearing.ts";
import type { VoiceState } from "./machine.ts";
import type { VoiceRoute } from "./support.ts";
import { VoiceTurns } from "./turns.ts";

function setup(
  opts: { route?: VoiceRoute; value?: string; refuse?: VoiceFailure; live?: boolean } = {},
) {
  const input = document.createElement("textarea");
  input.value = opts.value ?? "";
  document.body.append(input);
  let events: HearingEvents | undefined;
  let finish: (words: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let opened: () => void = () => {};
  const hearing: Hearing & { aborted: number } = {
    aborted: 0,
    level: () => 0.5,
    finish: () =>
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    abort() {
      hearing.aborted += 1;
    },
  };
  const states: VoiceState["phase"][] = [];
  const notices: (string | null)[] = [];
  const changes: (number | undefined)[] = [];
  const download = vi.fn();
  let t = 0;
  const turns = new VoiceTurns({
    field: () => input,
    route: () => opts.route ?? { kind: "device" },
    live: () => opts.live ?? true,
    hear: (_route, given) => {
      events = given;
      return new Promise((resolve, reject) => {
        opened = () => (opts.refuse ? reject(new VoiceError(opts.refuse)) : resolve(hearing));
      });
    },
    changed: (_input, caret) => changes.push(caret),
    view: (state) => states.push(state.phase),
    notice: (line) => notices.push(line),
    download,
    now: () => t,
  });
  const at = (ms: number) => {
    t = ms;
    return ms;
  };
  return {
    input,
    turns,
    hearing,
    states,
    notices,
    changes,
    download,
    at,
    events: () => events as HearingEvents,
    open: async () => {
      opened();
      await Promise.resolve();
      await Promise.resolve();
    },
    finish: async (words: string) => {
      finish(words);
      await Promise.resolve();
      await Promise.resolve();
    },
    fail: async (error: Error) => {
      fail(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("voice turns", () => {
  it("writes the words as they come and puts the final ones at the caret", async () => {
    const voice = setup({ value: "Then" });
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    expect(voice.turns.state.phase).toBe("listening");
    voice.events().partial("book a");
    expect(voice.input.value).toBe("Then book a");
    voice.events().partial("book a table");
    expect(voice.input.value).toBe("Then book a table");
    voice.turns.send({ type: "release", at: voice.at(1500) });
    expect(voice.turns.state.phase).toBe("finishing");
    await voice.finish("book a table for two");
    expect(voice.input.value).toBe("Then book a table for two");
    expect(voice.changes.at(-1)).toBe("Then book a table for two".length);
    expect(voice.states).toEqual(["starting", "listening", "finishing", "idle"]);
    expect(voice.hearing.aborted).toBe(0);
  });

  it("lands only the final words where the message is hidden while the user talks", async () => {
    const voice = setup({ value: "Hi", live: false });
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.events().partial("there");
    expect(voice.input.value).toBe("Hi");
    voice.turns.send({ type: "release", at: voice.at(1500) });
    await voice.finish("there dot");
    expect(voice.input.value).toBe("Hi there dot");
  });

  it("puts the message back as it was when cancelled", async () => {
    const voice = setup({ value: "Draft" });
    voice.turns.send({ type: "press", at: 0 });
    await voice.open();
    voice.events().partial("something else");
    voice.turns.send({ type: "cancel" });
    expect(voice.input.value).toBe("Draft");
    expect(voice.hearing.aborted).toBe(1);
    voice.events().partial("late words");
    expect(voice.input.value).toBe("Draft");
  });

  it("drops what was said when let go away from the mic", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.events().partial("never mind");
    voice.turns.send({ type: "away", away: true });
    voice.turns.send({ type: "release", at: voice.at(2000) });
    expect(voice.input.value).toBe("");
    expect(voice.turns.state.phase).toBe("idle");
    expect(voice.hearing.aborted).toBe(1);
  });

  it("says why when the microphone is not allowed", async () => {
    const voice = setup({ refuse: "denied" });
    voice.turns.send({ type: "press", at: 0 });
    await voice.open();
    expect(voice.turns.state.phase).toBe("idle");
    expect(voice.notices.at(-1)).toBe("Allow the microphone to talk to dot.");
  });

  it("says it didn't catch anything when nothing was heard", async () => {
    const voice = setup({ value: "Keep" });
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.turns.send({ type: "release", at: voice.at(1000) });
    await voice.finish("   ");
    expect(voice.input.value).toBe("Keep");
    expect(voice.notices.at(-1)).toBe("Didn't catch that. Try again.");
    expect(voice.turns.state.phase).toBe("idle");
  });

  it("puts the words so far back when turning them into text fails", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.events().partial("half");
    voice.turns.send({ type: "release", at: voice.at(1000) });
    await voice.fail(new VoiceError("busy"));
    expect(voice.input.value).toBe("");
    expect(voice.notices.at(-1)).toBe("Still writing down your last words.");
  });

  it("ends a turn the engine stopped by itself and reports its failures", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.events().ended();
    expect(voice.turns.state.phase).toBe("finishing");
    await voice.finish("done");
    expect(voice.input.value).toBe("done");
    voice.turns.send({ type: "press", at: voice.at(9000) });
    await voice.open();
    voice.events().failed("network");
    expect(voice.turns.state.phase).toBe("idle");
    expect(voice.notices.at(-1)).toBe("Couldn't reach the speech service.");
  });

  it("finishes at the longest recording", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    vi.advanceTimersByTime(120_000);
    expect(voice.turns.state.phase).toBe("finishing");
  });

  it("keeps the user's own edit over late words", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: voice.at(0) });
    await voice.open();
    voice.events().partial("hello");
    voice.input.value = "typed instead";
    voice.turns.send({ type: "release", at: voice.at(1000) });
    await voice.finish("hello there");
    expect(voice.input.value).toBe("typed instead");
  });

  it("explains a mic that can't hear here, and starts the download where one helps", () => {
    const off = setup({ route: { kind: "none", why: "online-off" } });
    off.turns.send({ type: "press", at: 0 });
    expect(off.turns.state.phase).toBe("idle");
    expect(off.notices.at(-1)).toBe("Allow online speech in Settings › Voice to talk here.");
    const later = setup({ route: { kind: "none", why: "download" } });
    later.turns.send({ type: "press", at: 0 });
    expect(later.download).toHaveBeenCalledTimes(1);
    expect(later.notices.at(-1)).toBe("Getting speech ready on this device…");
  });

  it("stops an engine that opens after the turn was cancelled", async () => {
    const voice = setup();
    voice.turns.send({ type: "press", at: 0 });
    voice.turns.send({ type: "cancel" });
    await voice.open();
    expect(voice.hearing.aborted).toBe(1);
    expect(voice.turns.state.phase).toBe("idle");
  });
});
