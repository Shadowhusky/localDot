// @vitest-environment jsdom
import { LocalDotEvent, outfit, type PersonaId, taskOutfit } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setWearing } from "../dot/wearing.ts";
import { createApi } from "../lib/api.ts";
import { Conversation } from "./Conversation.tsx";
import { DotChoice, dotChoiceLine } from "./DotChoice.tsx";
import { type AgentDotChoice, emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";
import { threadItems } from "./thread.ts";

afterEach(() => {
  cleanup();
  setWearing([]);
});

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

it("says which dot Auto chose and why, the user's usual one it fell back to, or their switch", () => {
  expect(dotChoiceLine(coder)).toBe("Auto chose Coder");
  expect(dotChoiceLine({ ...coder, persona: "finance", by: "default" })).toBe(
    "Working as Finance, your usual dot",
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
  render(<DotChoice choice={coder} wearables={[]} task={{ api, sessionId: ID }} />);
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
  render(<DotChoice choice={coder} wearables={[]} />);
  expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
});

it("wears the conversation's look as the chosen dot, whatever this localDot's accessory", () => {
  setWearing(outfit("coder", "cap"), "cap");
  const look = (persona: PersonaId) => taskOutfit(ID, persona);
  render(
    <DotChoice
      choice={{ ...coder, persona: "research", by: "default" }}
      wearables={look("research")}
    />,
  );
  const worn = () =>
    [...document.querySelectorAll<HTMLElement>(".thread-dot [data-wear]")]
      .map((img) => img.dataset.wear)
      .sort();
  expect(worn()).toEqual([...look("research")].sort());
  expect(worn()).not.toContain("cap");
});

it("draws each line of a thread in the look the conversation wore as that dot", () => {
  const look = (persona: PersonaId) => taskOutfit(ID, persona);
  const model = [
    ev(1, "message.user", {
      messageId: "01M4ECBR5X0R92SYA389FM3QAA",
      text: "Fix it",
      kind: "task",
    }),
    ev(2, "persona.choice", { persona: "coder", by: "default" }),
    ev(3, "persona.choice", { persona: "design", by: "user" }),
  ].reduce(projectAgentEvent, emptyAgentModel());
  render(
    <Conversation
      items={threadItems(model.messages.values(), [], [], [], [], undefined, model.dots)}
      truncated={false}
      dotLook={look}
    />,
  );
  const lines = [...document.querySelectorAll<HTMLElement>(".thread-dot")].map((line) =>
    [...line.querySelectorAll<HTMLElement>("[data-wear]")].map((img) => img.dataset.wear).sort(),
  );
  expect(lines).toEqual([[...look("coder")].sort(), [...look("design")].sort()]);
});
