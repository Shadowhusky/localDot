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
      Response.json({ answer: "Comparing two flights.", provider: "claude-code", model: "haiku" }),
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
      [409, "no-fast-model", /need a Fast model/, true],
      [409, "fast-model-not-running", /answers through a running task/, true],
      [409, "busy", /Wait for the answer/, false],
      [502, "no-answer", /didn't answer/, false],
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
        Response.json({
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
    expect(note.textContent).toContain("Answered by Claude Haiku, your Fast model");
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
          problem: "Side questions need a Fast model.",
          setup: true,
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Side questions need a Fast model.");
    fireEvent.click(screen.getByRole("button", { name: "Choose a Fast model" }));
    expect(onModels).toHaveBeenCalledOnce();
    view.rerender(<SideNote {...props} aside={{ kind: "usage", id: 3 }} />);
    expect(screen.getByRole("region", { name: "Plan usage" }).textContent).toContain(
      "Usage limits are for the ChatGPT and Claude Code plans",
    );
  });
});
