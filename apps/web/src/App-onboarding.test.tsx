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
it("lists what setup has left in the chat without starting tasks or saving policy", async () => {
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  const methods: string[] = [];
  const fetchImpl = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    methods.push(init?.method ?? "GET");
    const data =
      path === "/api/agent/settings"
        ? {}
        : path === "/api/agent/providers"
          ? providerFixture()
          : path === "/api/keys"
            ? { keys: [] }
            : path === "/api/keyd"
              ? {
                  online: true,
                  bootId: "test",
                  sealKey: "test",
                  audit: { ok: true },
                  hairpin: { state: "active", addresses: 1 },
                }
              : path === "/api/session-index"
                ? { sessions: [], next: null }
                : path === "/api/conversation"
                  ? { sessions: [], more: false }
                  : [];
    return Response.json(data);
  }) as typeof fetch;
  render(<App fetchImpl={fetchImpl} />);
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
    "PhoneOptional",
  ]);
  const choose = within(setup).getByRole("button", { name: "Choose…" });
  fireEvent.click(choose);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  expect(document.activeElement).toBe(choose);
  fireEvent.click(within(setup).getByRole("button", { name: "Continue setup" }));
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
  expect(methods.every((method) => method === "GET")).toBe(true);
});
it("offers one Turn on, on the curtain, with the island hidden under it", async () => {
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
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
