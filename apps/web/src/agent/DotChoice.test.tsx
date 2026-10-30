// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { DotChoice, dotChoiceLine } from "./DotChoice.tsx";
import { type AgentDotChoice, emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { threadItems } from "./thread.ts";

afterEach(cleanup);

const ID = "01M4ECBR5X0R92SYA389FM3Q00";
const ev = (seq: number, type: string, data: unknown) =>
  LocalDotEvent.parse({
    v: 1,
    id: `01M4ECBR5X0R92SYA389FM3Q${seq}0`,
    seq,
    t: seq,
    agent: "main",
    type,
    data,
  });
const coder: AgentDotChoice = { id: ID, seq: 2, persona: "coder", by: "auto", reason: "Code work" };

it("keeps each choice of dot in the task's model and places it where it was made", () => {
  const model = [
    ev(1, "message.user", {
      messageId: "01M4ECBR5X0R92SYA389FM3QAA",
      text: "Fix it",
      kind: "task",
    }),
    ev(2, "persona.choice", { persona: "coder", by: "auto", reason: "Code work" }),
    ev(3, "message.assistant", { messageId: "01M4ECBR5X0R92SYA389FM3QBB", text: "On it" }),
    ev(4, "persona.choice", { persona: "design", by: "user" }),
  ].reduce(projectAgentEvent, emptyAgentModel());
  expect(model.dots.map(({ persona, by }) => [persona, by])).toEqual([
    ["coder", "auto"],
    ["design", "user"],
  ]);
  const items = threadItems(model.messages.values(), [], [], [], [], undefined, model.dots);
  expect(items.map((item) => item.kind)).toEqual(["message", "dot", "message", "dot"]);
});

it("says which dot Auto chose and why, the default it fell back to, or the user's switch", () => {
  expect(dotChoiceLine(coder)).toBe("Auto chose Coder");
  expect(dotChoiceLine({ ...coder, persona: "finance", by: "default" })).toBe(
    "Working as Finance, your default: Auto had no quick answer",
  );
  expect(dotChoiceLine({ ...coder, persona: "design", by: "user" })).toBe(
    "You chose Designer for this conversation",
  );
});

it("changes the task's dot from the line while it works, and only then", async () => {
  const posted: { path: string; body: unknown }[] = [];
  const api = createApi("fixture", {
    origin: "http://fixture.test",
    fetchImpl: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posted.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  render(<DotChoice choice={coder} task={{ api, sessionId: ID }} />);
  expect(screen.getByText("Auto chose Coder").parentElement?.textContent).toBe(
    "Auto chose Coder · Code work",
  );
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  expect(screen.getByRole("menuitemradio", { name: "Coder" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Designer" }));
  await waitFor(() =>
    expect(posted).toEqual([
      { path: `/api/agent/sessions/${ID}/persona`, body: { persona: "design" } },
    ]),
  );
  cleanup();
  render(<DotChoice choice={coder} />);
  expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
});
