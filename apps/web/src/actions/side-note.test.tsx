// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { SideNote } from "./SideNote.tsx";
import { askSideQuestion } from "./side-question.ts";
import { useAside } from "./useAside.ts";

vi.mock("../ui/Announcer.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Announcer.tsx")>()),
  announce: vi.fn(),
}));
afterEach(cleanup);

const SESSION = "01JXYZ0000000000000000SESS";
const OTHER = "01JXYZ0000000000000000AAA2";

const lines = (...values: unknown[]) =>
  new Response(values.map((value) => `${JSON.stringify(value)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

function api(reply: (body: unknown) => Response | Promise<Response>) {
  const asked: { path: string; body: unknown }[] = [];
  return {
    asked,
    api: createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        asked.push({ path: new URL(String(url)).pathname, body });
        return reply(body);
      },
    }),
  };
}

describe("side questions", () => {
  it("asks the task's side-question route and says each refusal in the user's words", async () => {
    const ok = api(() =>
      lines({ answer: "Comparing two flights.", provider: "claude-code", model: "haiku" }),
    );
    await expect(
      askSideQuestion(ok.api, SESSION, "What now?", new AbortController().signal),
    ).resolves.toEqual({
      answer: "Comparing two flights.",
      provider: "claude-code",
      model: "haiku",
    });
    expect(ok.asked).toEqual([
      { path: `/api/agent/sessions/${SESSION}/side-question`, body: { question: "What now?" } },
    ]);
    const cases: [number, string, RegExp, boolean][] = [
      [409, "no-model", /Choose a model/, true],
      [409, "no-spare-model", /one request at a time.*stays with the models you chose/, true],
      [409, "no-tool-model", /can't use tools.*stays with the models you chose/, true],
      [409, "busy", /Wait for the answer/, false],
      [502, "no-answer", /No model could answer/, false],
      [502, "no-answer\nanswered 400: Input must be a list", /Input must be a list/, false],
      [400, "invalid user text", /up to 2,000 characters/, false],
    ];
    for (const [status, text, said, setup] of cases) {
      const refused = api(() => new Response(text, { status }));
      await expect(
        askSideQuestion(refused.api, SESSION, "Why?", new AbortController().signal),
      ).rejects.toMatchObject({ message: expect.stringMatching(said), setup });
    }
  });

  it("shows the question at once, then its answer, and leaves it behind with its task", async () => {
    let answer!: (reply: Response) => void;
    const remote = api(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const view = renderHook(({ id }) => useAside(remote.api, id), {
      initialProps: { id: SESSION },
    });
    act(() => view.result.current.ask("Which airline?"));
    expect(view.result.current.aside).toMatchObject({
      kind: "question",
      phase: "asking",
      question: "Which airline?",
    });
    await act(async () =>
      answer(
        lines({
          answer: "TAP is cheaper.",
          provider: "anthropic",
          model: "claude-haiku-4-5",
        }),
      ),
    );
    await waitFor(() => expect(view.result.current.aside).toMatchObject({ phase: "answered" }));
    view.rerender({ id: OTHER });
    expect(view.result.current.aside).toBeNull();
    act(() => view.result.current.showUsage());
    expect(view.result.current.aside).toMatchObject({ kind: "usage" });
    act(() => view.result.current.dismiss());
    expect(view.result.current.aside).toBeNull();
  });

  it("says which model answered and why the one asked first didn't", () => {
    render(
      <SideNote
        plans={[]}
        usage={null}
        modelName={(_provider: string, model: string) => model}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onModels={vi.fn()}
        onSpending={vi.fn()}
        aside={{
          kind: "question",
          id: 1,
          sessionId: SESSION,
          question: "Which airline?",
          phase: "answered",
          answer: {
            answer: "TAP.",
            provider: "custom",
            model: "gpt-6.1-sol",
            failed: { model: "gpt-6.1-terra", reason: "answered 400: Input must be a list" },
          },
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "Side question" }).textContent).toContain(
      "Answered by gpt-6.1-sol, as gpt-6.1-terra didn't: answered 400: Input must be a list",
    );
  });

  it("marks the answer as the user's alone, and offers the fix for what failed", () => {
    const onDismiss = vi.fn();
    const onModels = vi.fn();
    const onRetry = vi.fn();
    const props = {
      plans: [],
      usage: null,
      modelName: (_provider: string, model: string) => (model === "haiku" ? "Claude Haiku" : model),
      onDismiss,
      onRetry,
      onStop: vi.fn(),
      onModels,
      onSpending: vi.fn(),
    };
    const view = render(
      <SideNote
        {...props}
        aside={{
          kind: "question",
          id: 1,
          sessionId: SESSION,
          question: "Which airline?",
          phase: "answered",
          answer: { answer: "**TAP** is cheaper.", provider: "claude-code", model: "haiku" },
        }}
      />,
    );
    const note = screen.getByRole("region", { name: "Side question" });
    expect(note.textContent).toContain("Only you see this. dot doesn't.");
    expect(note.querySelector("strong")?.textContent).toBe("TAP");
    expect(note.textContent).toContain("Answered by Claude Haiku");
    fireEvent.click(screen.getByRole("button", { name: "Close side question" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    view.rerender(
      <SideNote
        {...props}
        aside={{
          kind: "question",
          id: 2,
          sessionId: SESSION,
          question: "Why?",
          phase: "failed",
          problem: "Choose a model for this task first.",
          setup: true,
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Choose a model for this task first.");
    fireEvent.click(screen.getByRole("button", { name: "Choose a model" }));
    expect(onModels).toHaveBeenCalledOnce();
    view.rerender(<SideNote {...props} aside={{ kind: "usage", id: 3 }} />);
    expect(screen.getByRole("region", { name: "Plan usage" }).textContent).toContain(
      "Usage limits are for the ChatGPT and Claude Code plans",
    );
  });

  describe("as it works", () => {
    const base = {
      plans: [],
      usage: null,
      modelName: (_provider: string, model: string) => (model === "opus" ? "Claude Opus" : model),
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      onStop: vi.fn(),
      onModels: vi.fn(),
      onSpending: vi.fn(),
    };
    const aside = (more: Record<string, unknown>) =>
      ({
        kind: "question",
        id: 1,
        sessionId: SESSION,
        question: "Did it pay?",
        phase: "answered",
        ...more,
      }) as never;

    it("hands each step on as it comes, then the answer", async () => {
      const body = new TransformStream<Uint8Array, Uint8Array>();
      const writer = body.writable.getWriter();
      const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
      const remote = api(
        () => new Response(body.readable, { headers: { "content-type": "application/x-ndjson" } }),
      );
      const view = renderHook(() => useAside(remote.api, SESSION));
      act(() => view.result.current.ask("Did it pay?"));
      await act(async () => {
        await writer.write(encode({ progress: "Checking the terminal output…" }));
      });
      await waitFor(() =>
        expect(view.result.current.aside).toMatchObject({
          phase: "asking",
          steps: [{ progress: "Checking the terminal output…" }],
        }),
      );
      await act(async () => {
        await writer.write(
          encode({ handover: { provider: "a", model: "opus" }, partial: "No receipt yet." }),
        );
        await writer.write(encode({ answer: "It paid.", provider: "a", model: "opus" }));
        await writer.close();
      });
      await waitFor(() =>
        expect(view.result.current.aside).toMatchObject({
          phase: "answered",
          answer: { answer: "It paid." },
        }),
      );
    });

    it("says what stopped it, when that comes after it started", async () => {
      const remote = api(() =>
        lines(
          { progress: "Reading…" },
          { problem: "no-answer", status: 502, reason: "answered 529: Overloaded" },
        ),
      );
      await expect(
        askSideQuestion(remote.api, SESSION, "Hi", new AbortController().signal),
      ).rejects.toMatchObject({ message: expect.stringContaining("answered 529: Overloaded") });
    });

    it("stops when asked, keeps the question and offers to ask again", async () => {
      let signal: AbortSignal | undefined;
      const remote = createApi("fixture", {
        origin: "http://127.0.0.1:4790",
        fetchImpl: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        },
      });
      const view = renderHook(() => useAside(remote, SESSION));
      act(() => view.result.current.ask("Did it pay?"));
      await waitFor(() => expect(signal).toBeDefined());
      act(() => view.result.current.stop());
      expect(signal?.aborted).toBe(true);
      expect(view.result.current.aside).toMatchObject({
        phase: "stopped",
        question: "Did it pay?",
      });
      const onRetry = vi.fn();
      render(<SideNote {...base} onRetry={onRetry} aside={aside({ phase: "stopped" })} />);
      expect(screen.getByRole("status").textContent).toBe("Stopped.");
      fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("shows the latest step, the ones before it, what was found so far and a way to stop", () => {
      const onStop = vi.fn();
      render(
        <SideNote
          {...base}
          onStop={onStop}
          aside={aside({
            phase: "asking",
            steps: [
              { progress: "Searching the task's log…" },
              {
                handover: { provider: "anthropic", model: "opus" },
                partial: "**The log** mentions no receipt.",
              },
            ],
          })}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe("Asking Claude Opus…");
      const note = screen.getByRole("region", { name: "Side question" });
      expect(note.textContent).toContain("Searching the task's log…");
      expect(note.textContent).toContain("So far");
      expect(note.querySelector(".side-note-partial strong")?.textContent).toBe("The log");
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(onStop).toHaveBeenCalledOnce();
    });

    it("shows its sources in plain words, who answered and what it cost", () => {
      render(
        <SideNote
          {...base}
          aside={aside({
            answer: {
              answer: "It paid.",
              provider: "anthropic",
              model: "opus",
              status: "found",
              sources: ["terminal", "screen", "web"],
              handedOver: { provider: "anthropic", model: "haiku" },
              spend: {
                usd: 0.0127,
                inputTokens: 4400,
                outputTokens: 210,
                plan: false,
                taskUSD: 0.05,
              },
            },
          })}
        />,
      );
      const text = screen.getByRole("region", { name: "Side question" }).textContent;
      expect(text).toContain("From the terminal output, the screen and the web.");
      expect(text).toContain("Answered by Claude Opus, after haiku couldn't find it");
      expect(text).toContain("≈\u00a0$0.01");
      expect(text).toContain("≈\u00a0$0.05 for this task's side questions so far");
      expect(text).toContain("Not counted in the task's budget.");
    });

    it("gives a plan's use in tokens, not money", () => {
      render(
        <SideNote
          {...base}
          aside={aside({
            answer: {
              answer: "It paid.",
              provider: "claude-code",
              model: "haiku",
              spend: { usd: 0, inputTokens: 1000, outputTokens: 200, plan: true, taskUSD: 0 },
            },
          })}
        />,
      );
      const text = screen.getByRole("region", { name: "Side question" }).textContent;
      expect(text).toContain("Used 1,200 tokens of your plan.");
      expect(text).not.toContain("$");
    });

    it.each([
      ["time", "time limit"],
      ["cost", "cost limit"],
      ["no-main", "no other model to ask"],
    ])("says why it ended short: %s", (ended, said) => {
      render(
        <SideNote
          {...base}
          aside={aside({
            answer: {
              answer: "What it found.",
              provider: "p",
              model: "m",
              status: "partial",
              ended,
            },
          })}
        />,
      );
      expect(screen.getByRole("region", { name: "Side question" }).textContent).toContain(said);
    });
  });

  describe("links in an answer", () => {
    const props = {
      plans: [],
      usage: null,
      modelName: (_provider: string, model: string) => model,
      onDismiss: vi.fn(),
      onRetry: vi.fn(),
      onStop: vi.fn(),
      onModels: vi.fn(),
      onSpending: vi.fn(),
    };
    const TEXT =
      "Done. [Open the full report](https://evil.example/r?d=99-1234), ![x](https://evil.example/p?d=1), https://evil.example/bare?d=2 and [the hours](https://example.org/hours).";
    const shown = (answer: Record<string, unknown>, phase = "answered") =>
      render(
        <SideNote
          {...props}
          aside={
            {
              kind: "question",
              id: 1,
              sessionId: SESSION,
              question: "Q",
              phase,
              ...answer,
            } as never
          }
        />,
      );
    const hrefs = (root: HTMLElement) =>
      [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));

    it("opens only an address the user wrote or its own search found; others are plain text", () => {
      const view = shown({
        answer: {
          answer: TEXT,
          provider: "p",
          model: "m",
          links: ["https://example.org/hours"],
        },
      });
      const note = view.getByRole("region", { name: "Side question" });
      expect(hrefs(note)).toEqual(["https://example.org/hours"]);
      expect(note.textContent).toContain("Open the full report (evil.example)");
      expect(note.textContent).toContain("https://evil.example/bare?d=2");
    });

    it("opens the allowed address itself, never the model's fragment or spelling", () => {
      const view = shown({
        answer: {
          answer:
            "[Open](https://example.org/hours#d=99-1234), https://example.org/hours#d=5, [again](https://EXAMPLE.org:443/x/../hours), [q](https://example.org/hours?d=1) and [u](https://d:99@example.org/hours)",
          provider: "p",
          model: "m",
          links: ["https://example.org/hours"],
        },
      });
      expect(hrefs(view.getByRole("region", { name: "Side question" }))).toEqual([
        "https://example.org/hours",
        "https://example.org/hours",
        "https://example.org/hours",
      ]);
    });

    it("opens nothing when the answer names no address it may open", () => {
      const view = shown({ answer: { answer: TEXT, provider: "p", model: "m" } });
      expect(hrefs(view.getByRole("region", { name: "Side question" }))).toEqual([]);
    });

    it("opens nothing in what was found so far", () => {
      const view = shown(
        { steps: [{ handover: { provider: "p", model: "m" }, partial: TEXT }] },
        "asking",
      );
      expect(hrefs(view.getByRole("region", { name: "Side question" }))).toEqual([]);
    });
  });
});
