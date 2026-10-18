// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { VoiceError } from "../voice/capture.ts";
import type { HearingEvents } from "../voice/hearing.ts";
import { isListening } from "../voice/listening.ts";
import { changeVoicePrefs } from "../voice/prefs.ts";
import { Composer, type ComposerProps } from "./Composer.tsx";
import { emptyAgentModel } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

// The speech engine, played by the test: it opens when told, says words, and finishes on cue.
const engine = vi.hoisted(() => ({
  events: undefined as HearingEvents | undefined,
  open: undefined as (() => void) | undefined,
  refuse: undefined as Error | undefined,
  finish: undefined as ((words: string) => void) | undefined,
  aborted: 0,
  listeningAtStart: false,
}));
vi.mock("../voice/hearing.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../voice/hearing.ts")>()),
  startHearing: (_route: unknown, _opts: unknown, events: HearingEvents) => {
    engine.events = events;
    engine.listeningAtStart = isListening();
    return new Promise((resolve, reject) => {
      engine.open = () =>
        engine.refuse
          ? reject(engine.refuse)
          : resolve({
              level: () => 0.4,
              finish: () =>
                new Promise<string>((done) => {
                  engine.finish = done;
                }),
              abort: () => {
                engine.aborted += 1;
              },
            });
    });
  },
}));

const cellId = "01JXYZ0000000000000000CE11";
const sessionId = "01JXYZ0000000000000000SESS";
const cell: CellSummary = {
  id: cellId,
  state: "ready",
  scale: 2,
  createdAt: "t",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
const agent: AgentSessionView = {
  sessionId,
  model: emptyAgentModel(),
  snapshot: { sessionId, cellId, status: "running", toolCalls: 0 },
  availability: "ready",
  error: null,
  fresh: true,
  connection: "live",
  reconcile: vi.fn(),
};

let clock = 0;
beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  engine.events = undefined;
  engine.open = undefined;
  engine.refuse = undefined;
  engine.finish = undefined;
  engine.aborted = 0;
  engine.listeningAtStart = false;
  vi.stubGlobal(
    "webkitSpeechRecognition",
    Object.assign(class {}, { available: async () => "available" }),
  );
  // Chrome, which hears on the device.
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { brands: [{ brand: "Google Chrome", version: "154" }] },
  });
  changeVoicePrefs({ language: "en-US", online: false });
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "userAgentData");
});

async function setup(over: Partial<ComposerProps> = {}) {
  const requests: unknown[] = [];
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (_url, init) => {
      if (init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify({ onMac: { available: false } }));
    },
  });
  const props: ComposerProps = {
    api,
    cell,
    agent,
    known: true,
    pending: false,
    keysOpen: false,
    receiveKey: vi.fn(() => false),
    ...over,
  };
  const view = render(<Composer {...props} />);
  const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
  const mic = document.querySelector(".voice-mic button") as HTMLButtonElement;
  // The route is known once the browser has answered.

  await act(async () => {});
  const opened = async () => {
    await waitFor(() => expect(engine.open).toBeDefined());
    await act(async () => engine.open?.());
  };
  return { ...view, props, requests, field, mic, opened };
}

describe("talking to dot from the composer", () => {
  it("taps to record, then stops to keep the complete transcript for editing", async () => {
    const f = await setup();
    fireEvent.input(f.field, { target: { value: "Please" } });
    fireEvent.click(f.mic);
    expect(engine.listeningAtStart).toBe(true);
    await f.opened();
    expect(f.mic.getAttribute("aria-label")).toBe("Stop recording");
    expect(isListening()).toBe(true);
    expect(f.field.readOnly).toBe(true);
    act(() => engine.events?.partial("book a table"));
    expect(f.field.value).toBe("Please book a table");
    expect(screen.getByRole("button", { name: "Send voice message" })).toBeTruthy();
    fireEvent.click(f.mic);
    expect(f.mic.getAttribute("aria-label")).toBe("Transcribing speech");
    expect(screen.getByRole("status").textContent).toBe("Transcribing…");
    expect(f.container.querySelector(".voice-spinner")).toBeTruthy();
    expect(f.container.querySelector(".voice-wave")).toBeNull();
    await act(async () => engine.finish?.("book a table for two"));
    expect(f.field.value).toBe("Please book a table for two");
    expect(f.field.readOnly).toBe(false);
    expect(document.activeElement).toBe(f.field);
    expect(isListening()).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it("Send waits for the last words and delivers once without stopping the agent task", async () => {
    const run = vi.fn();
    const f = await setup({ taskAction: { kind: "stop", run } });
    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("look at"));
    const send = screen.getByRole("button", { name: "Send voice message" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(f.requests).toEqual([]);
    await act(async () => engine.finish?.("look at the final frame"));
    expect(f.requests).toEqual([{ kind: "followup", text: "look at the final frame" }]);
    expect(run).not.toHaveBeenCalled();
    expect(f.field.value).toBe("");
  });

  it("can send a transcript already being finished by Stop", async () => {
    const f = await setup({ layout: "pill" });
    fireEvent.input(f.field, { target: { value: "Please" } });
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(f.mic);
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await act(async () => engine.finish?.("check this"));
    expect(f.requests).toEqual([{ kind: "followup", text: "Please check this" }]);
  });

  it("Cancel during transcription restores the original draft and ignores late words", async () => {
    const f = await setup();
    fireEvent.input(f.field, { target: { value: "Keep this" } });
    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("discard this"));
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    await act(async () => engine.finish?.("late discarded words"));
    expect(f.field.value).toBe("Keep this");
    expect(f.requests).toEqual([]);
    expect(engine.aborted).toBe(1);
  });

  it("does not submit speech into a different conversation", async () => {
    const f = await setup();
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    f.rerender(
      <Composer {...f.props} agent={{ ...agent, sessionId: "01JXYZ0000000000000000NEXT" }} />,
    );
    await act(async () => engine.finish?.("words from the old conversation"));
    expect(f.requests).toEqual([]);
    expect(f.field.value).toBe("");
  });

  it("keeps words in the draft when the computer goes offline before Send finishes", async () => {
    const f = await setup();
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    f.rerender(<Composer {...f.props} cell={{ ...cell, paused: true }} />);
    await act(async () => engine.finish?.("keep these words"));
    expect(f.requests).toEqual([]);
    expect(f.field.value).toBe("keep these words");
    expect(screen.getByRole("alert").textContent).toContain("Resume your computer first");
  });

  it("does not send an existing draft when no speech was heard", async () => {
    const f = await setup();
    fireEvent.input(f.field, { target: { value: "Unsent draft" } });
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await act(async () => engine.finish?.(""));
    expect(f.requests).toEqual([]);
    expect(f.field.value).toBe("Unsent draft");
  });

  it("cancels dictation with Escape, putting the message back", async () => {
    const f = await setup();
    fireEvent.input(f.field, { target: { value: "Keep this" } });
    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("oops"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(f.field.value).toBe("Keep this");
    expect(engine.aborted).toBe(1);
  });

  it("says when the microphone isn't allowed", async () => {
    engine.refuse = new VoiceError("denied");
    const f = await setup();
    fireEvent.click(f.mic);
    await f.opened();
    expect(screen.getByRole("status").textContent).toBe("Allow the microphone to talk to dot.");
    expect(f.mic.getAttribute("aria-label")).toBe("Start voice input");
  });

  it("says when nothing was heard", async () => {
    const f = await setup();
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(f.mic);
    await waitFor(() => expect(engine.finish).toBeDefined());
    await act(async () => engine.finish?.(""));
    expect(screen.getByRole("status").textContent).toBe("Didn't catch that. Try again.");
    expect(f.field.value).toBe("");
  });

  it("dismisses microphone errors immediately, including with Escape", async () => {
    engine.refuse = new VoiceError("denied");
    const f = await setup();
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss voice notice" }));
    expect(screen.queryByText("Allow the microphone to talk to dot.")).toBeNull();
    fireEvent.click(f.mic);
    await f.opened();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Allow the microphone to talk to dot.")).toBeNull();
  });

  it("talks while Control-Shift-Space is held, off a Mac", async () => {
    const f = await setup();
    // On the page, where the field has a box (jsdom lays nothing out).
    vi.spyOn(f.field, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
    fireEvent.keyDown(document, { code: "Space", key: " ", ctrlKey: true, shiftKey: true });
    await f.opened();
    act(() => engine.events?.partial("from the keyboard"));
    clock += 1200;
    fireEvent.keyUp(document, { code: "Space", key: " " });
    await waitFor(() => expect(engine.finish).toBeDefined());
    await act(async () => engine.finish?.("from the keyboard"));
    expect(f.field.value).toBe("from the keyboard");
  });

  it("waits while the message can't be written", async () => {
    const f = await setup();
    f.rerender(
      <Composer
        api={createApi("fixture", { origin: "http://127.0.0.1:4790" })}
        cell={cell}
        agent={agent}
        known
        pending={false}
        keysOpen={false}
        controlBlocked
        receiveKey={vi.fn(() => false)}
      />,
    );
    expect(f.mic.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(f.mic);
    expect(engine.open).toBeUndefined();
  });

  it("explains how to enable speech without starting capture when online speech is off", async () => {
    vi.stubGlobal("webkitSpeechRecognition", class {});
    changeVoicePrefs({ language: "fr-FR" });
    render(
      <Composer
        api={createApi("fixture", {
          origin: "http://127.0.0.1:4790",
          fetchImpl: async () => new Response("", { status: 404 }),
        })}
        cell={cell}
        agent={agent}
        known
        pending={false}
        keysOpen={false}
        receiveKey={vi.fn(() => false)}
      />,
    );
    const mic = document.querySelector(".voice-mic button") as HTMLButtonElement;
    await act(async () => {});

    fireEvent.click(mic);
    expect(await screen.findByRole("button", { name: "Enable online speech" })).toBeTruthy();
    expect(engine.open).toBeUndefined();
  });
});

it.each([undefined, "pill"] as const)(
  "streams successive recordings in %s layout",
  async (layout) => {
    const f = await setup({ layout });
    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("first"));
    expect(f.field.value).toBe("first");
    act(() => engine.events?.partial("first message"));
    expect(f.field.value).toBe("first message");
    fireEvent.click(f.mic);
    await act(async () => engine.finish?.("first message complete"));

    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("cancel these words"));
    expect(f.field.value).toContain("cancel these words");
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(f.field.value).toBe("first message complete");

    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("then"));
    expect(f.field.value).toBe("first message complete then");
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await act(async () => engine.finish?.("then send this"));
    expect(f.requests).toEqual([
      { kind: "followup", text: "first message complete then send this" },
    ]);
    expect(f.field.value).toBe("");

    fireEvent.click(f.mic);
    await f.opened();
    act(() => engine.events?.partial("next recording"));
    expect(f.field.value).toBe("next recording");
    fireEvent.click(f.mic);
    await act(async () => engine.finish?.("next recording works"));
    expect(f.field.value).toBe("next recording works");
  },
);
