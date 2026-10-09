// @vitest-environment jsdom
import type { PauseSnapshot } from "@localdot/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type AgentFeedState, emptyAgentModel } from "./model.ts";
import { SafetyNotes } from "./SafetyNotes.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import { type SafetyView, useSafety } from "./useSafety.ts";

const CELL = "01J00000000000000000000001";
const SESSION = "01J00000000000000000000002";
const REQUEST = "01J00000000000000000000003";
const pause: PauseSnapshot = {
  requestId: REQUEST,
  revision: 1,
  phase: "paused",
  reason: "user",
  atStepBoundary: true,
  resumeAvailable: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 204 }))) {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const cell = {
    id: CELL,
    state: "ready" as const,
    scale: 1 as const,
    createdAt: "",
    stream: { connection: "live" as const, viewers: 1, lastUpstreamAt: 1 },
  };
  let state: AgentFeedState = {
    cellId: CELL,
    sessionId: SESSION,
    epoch: 7,
    connection: "live",
    replayed: true,
    history: true,
    streamError: null,
    model: { ...emptyAgentModel(), safetyPause: pause },
  };
  const listeners = new Set<() => void>();
  const feed = {
    read: () => state,
    subscribe: (f: () => void) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
  };
  const agent: AgentSessionView = {
    sessionId: SESSION,
    model: state.model,
    snapshot: { sessionId: SESSION, cellId: CELL, status: "paused", toolCalls: 0, pause },
    availability: "ready",
    error: null,
    fresh: true,
    authorityEpoch: 7,
    connection: "live",
    reconcile: vi.fn(),
  };
  const api = createApi("inert", { origin: "https://owned.invalid", fetchImpl });
  let current!: SafetyView;
  function Harness() {
    current = useSafety({
      api,
      cell,
      agent,
      feed,
      blocked: false,
      visible: true,
      selectReady: async () => true,
    });
    return (
      <>
        <iframe src="about:blank" title="Desktop stream client" />
        <label>
          Parent task draft
          <input aria-label="Parent task draft" />
        </label>
        <SafetyNotes safety={current} agent={agent} />
      </>
    );
  }
  const view = render(<Harness />);
  const input = view.getByRole("textbox", { name: "Parent task draft" }) as HTMLInputElement;
  const frame = view.getByTitle("Desktop stream client") as HTMLIFrameElement;
  const seen: { target: string; trusted: boolean }[] = [];
  const record = (e: FocusEvent) => {
    seen.push({ target: (e.target as Element).tagName, trusted: e.isTrusted });
  };
  document.addEventListener("focusin", record);
  const intoViewer = () => {
    act(() => {
      frame.focus();
      // Replay the window blur captured in the actual author Chrome diagnostic.
      // document.hasFocus remains true: this is focus within the same top-level window.
      window.dispatchEvent(new Event("blur"));
    });
    expect(current.canResume).toBe(false);
  };
  const parentFocus = () =>
    act(() => {
      input.focus();
    });
  return {
    ...view,
    focus,
    hidden,
    input,
    frame,
    seen,
    intoViewer,
    parentFocus,
    fetchImpl,
    current: () => current,
    stale: () =>
      act(() => {
        state = { ...state, epoch: 8 };
        for (const f of listeners) f();
      }),
    clean: () => document.removeEventListener("focusin", record),
  };
}

it("an explicit Resume works for the current paused owner before viewer focus", async () => {
  const f = fixture();
  try {
    expect(f.current().canResume).toBe(true);
    await act(async () => {
      expect(await f.current().resume()).toBe(true);
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    f.clean();
  }
});
it("returning DOM focus from the embedded viewer to parent controls restores explicit Resume", async () => {
  const f = fixture();
  try {
    expect(f.current().canResume).toBe(true);
    f.intoViewer();
    expect(f.fetchImpl).toHaveBeenCalledTimes(0);
    f.parentFocus();
    expect(document.activeElement).toBe(f.input);
    expect(f.seen.at(-1)).toEqual({ target: "INPUT", trusted: true });
    expect(document.hasFocus()).toBe(true);
    const enabled = f.current().canResume;
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await f.current().resume();
    });
    expect({ enabled, accepted, posts: vi.mocked(f.fetchImpl).mock.calls.length }).toEqual({
      enabled: true,
      accepted: true,
      posts: 1,
    });
  } finally {
    f.clean();
  }
});
it("a forged window focus cannot authorize a top document that remains unfocused", async () => {
  const f = fixture();
  try {
    f.intoViewer();
    f.focus.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("focus")));
    const enabled = f.current().canResume;
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await f.current().resume();
    });
    expect({ enabled, accepted, posts: vi.mocked(f.fetchImpl).mock.calls.length }).toEqual({
      enabled: false,
      accepted: false,
      posts: 0,
    });
  } finally {
    f.clean();
  }
});
it.each(["focusin", "pointerdown"] as const)(
  "synthetic parent %s cannot restore focus admission",
  async (kind) => {
    const f = fixture();
    try {
      f.intoViewer();
      act(() => f.input.dispatchEvent(new Event(kind, { bubbles: true })));
      expect(f.current().canResume).toBe(false);
      await act(async () => {
        expect(await f.current().resume()).toBe(false);
      });
      expect(f.fetchImpl).toHaveBeenCalledTimes(0);
    } finally {
      f.clean();
    }
  },
);
it.each(["hidden", "unfocused", "stale owner"] as const)(
  "parent focus cannot admit a %s owner",
  async (mode) => {
    const f = fixture();
    try {
      f.intoViewer();
      if (mode === "hidden") f.hidden.mockReturnValue(true);
      else if (mode === "unfocused") f.focus.mockReturnValue(false);
      else f.stale();
      f.parentFocus();
      expect(f.current().canResume).toBe(false);
      await act(async () => {
        expect(await f.current().resume()).toBe(false);
      });
      expect(f.fetchImpl).toHaveBeenCalledTimes(0);
    } finally {
      f.clean();
    }
  },
);
it("viewer blur aborts an in-flight Resume and never retries it", async () => {
  const reply = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init?.signal;
    return reply.promise;
  });
  const f = fixture(fetchImpl);
  try {
    let work!: Promise<boolean>;
    act(() => {
      work = f.current().resume();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    f.intoViewer();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      reply.resolve(new Response(null, { status: 204 }));
      await work;
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    f.clean();
  }
});
