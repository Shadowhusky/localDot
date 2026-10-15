// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "./App.tsx";
import { TOKEN_KEY } from "./lib/token.ts";
import { providerFixture } from "./settings/testing.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const KEYD = {
  online: true,
  bootId: "test",
  sealKey: "test",
  audit: { ok: true },
  hairpin: { state: "active", addresses: 1 },
};

function daemon(settings: Record<string, unknown> = {}, keys: unknown[] = []) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let saved = settings;
  const fetchImpl = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === "PUT" && path === "/api/agent/settings") {
      saved = body;
      return Response.json(saved);
    }
    if (method === "POST") return new Promise<Response>(() => {});
    const data =
      path === "/api/agent/settings"
        ? saved
        : path === "/api/agent/providers"
          ? providerFixture()
          : path === "/api/keys"
            ? { keys }
            : path === "/api/keyd"
              ? KEYD
              : path === "/api/session-index"
                ? { sessions: [], next: null }
                : path === "/api/conversation"
                  ? { sessions: [], more: false }
                  : [];
    return Response.json(data);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

it("opens setup on first run, and Finish later leaves what is left in the chat to continue", async () => {
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  const { fetchImpl, calls } = daemon();
  render(<App fetchImpl={fetchImpl} />);
  fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
  expect(await screen.findByRole("heading", { name: "How should dot think?" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "Step 1 of 6 · How dot thinks" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "How should dot think?" })).toBeNull(),
  );
  const setup = await screen.findByRole("region", { name: "Finish setting up" });
  expect(setup.textContent).toContain("0 of 6 steps done. dot needs a model before it can start.");
  expect(
    within(setup)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual([
    "How dot thinksNot chosen yet",
    "KeyNot added yet",
    "ModelNeeded to startChoose…",
    "PermissionsBalanced until you choose",
    "Your dotEveryday until you choose",
  ]);
  const choose = within(setup).getByRole("button", { name: "Choose…" });
  fireEvent.click(choose);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  expect(document.activeElement).toBe(choose);
  // A reload keeps setup put off; Continue setup comes back to where it was.
  expect(JSON.parse(localStorage.getItem("localdot.onboarding.v1") ?? "{}")).toEqual({
    step: "thinks",
    dismissed: true,
  });
  fireEvent.click(within(setup).getByRole("button", { name: "Continue setup" }));
  expect(await screen.findByRole("heading", { name: "How should dot think?" })).toBeTruthy();
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("sets up an API key's models and permissions, then turns the computer on", async () => {
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  const stored = {
    id: "anthropic",
    kind: "llm",
    provider: "anthropic",
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T09:00:00Z",
  };
  const { fetchImpl, calls } = daemon({}, [stored]);
  render(<App fetchImpl={fetchImpl} />);
  fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
  await screen.findByRole("heading", { name: "How should dot think?" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Add your API key" });
  // The saved Anthropic key is used without pasting it again.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Continue" }).getAttribute("aria-disabled")).toBe(
      null,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Which model should do the work?" });
  expect(screen.getByText("Claude Sonnet 5.5")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "How often should dot check with you?" });
  const puts = () => calls.filter((call) => call.method === "PUT").map((call) => call.body);
  expect(puts()).toEqual([
    {
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001", key: "anthropic" },
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Which dot do you need most?" });
  // Balanced is saved too, so setup knows it was chosen.
  expect(puts()[1]).toMatchObject({ autonomy: { computer: "act", purchase: "ask" } });
  fireEvent.click(screen.getByRole("radio", { name: /Coder/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "You're all set." });
  expect(puts()[2]).toMatchObject({ persona: "coder" });
  fireEvent.click(screen.getByRole("button", { name: "Turn on your computer" }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/cells")).toBe(true),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "You're all set." })).toBeNull(),
  );
  expect(JSON.parse(localStorage.getItem("localdot.onboarding.v1") ?? "{}")).toMatchObject({
    finished: true,
  });
});

it("offers one Turn on, on the curtain, with the island hidden under it", async () => {
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  localStorage.setItem(
    "localdot.onboarding.v1",
    JSON.stringify({ step: "thinks", dismissed: true }),
  );
  const posts: string[] = [];
  const created = Promise.withResolvers<Response>();
  const fetchImpl = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      posts.push(path);
      return created.promise;
    }
    const data =
      path === "/api/agent/settings"
        ? {}
        : path === "/api/agent/providers"
          ? providerFixture()
          : path === "/api/keys"
            ? { keys: [] }
            : path === "/api/session-index"
              ? { sessions: [], next: null }
              : path === "/api/conversation"
                ? { sessions: [], more: false }
                : [];
    return Response.json(data);
  }) as typeof fetch;
  render(<App fetchImpl={fetchImpl} />);
  await screen.findByRole("heading", { name: "Your computer is off" });
  expect(screen.getByText("Turn it on to start your first task.")).toBeTruthy();
  const [footer, ...more] = screen.getAllByRole("button", { name: "Turn on" });
  if (!footer) throw new Error("expected a Turn on control");
  expect(more).toEqual([]);
  expect(document.querySelector(".island")?.getAttribute("data-shape")).toBe("hidden");
  expect(screen.queryByRole("button", { name: /^Start(?! task)/ })).toBeNull();
  expect(footer.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(footer);
  expect(posts).toEqual(["/api/cells"]);
  await waitFor(() => expect(footer.getAttribute("aria-disabled")).toBe("true"));
  fireEvent.click(footer);
  expect(posts).toEqual(["/api/cells"]);
});
