// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "./App.tsx";
import { TOKEN_KEY } from "./lib/token.ts";
import { APPEARANCE_KEY } from "./onboarding/appearance.ts";
import { providerFixture } from "./settings/testing.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.appearance;
});
it("guides an empty authenticated workspace without starting tasks or saving policy", async () => {
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
                : [];
    return Response.json(data);
  }) as typeof fetch;
  render(<App fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "Set up localDot" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Midnight" }));
  await waitFor(() => expect(document.documentElement.dataset.appearance).toBe("midnight"));
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe("midnight");
  fireEvent.click(screen.getByRole("button", { name: "Review when dot checks with you" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(within(dialog).getByRole("radiogroup", { name: "Start from" })).getByRole("radio", {
        name: "Balanced",
      }),
    ),
  );
  expect(
    (within(dialog).getByRole("radio", { name: "Midnight" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Review when dot checks with you" }),
  );
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
  await screen.findByRole("heading", { name: "Set up localDot" });
  const [footer, ...more] = screen.getAllByRole("button", { name: "Turn on" });
  if (!footer) throw new Error("expected a Turn on control");
  expect(more).toEqual([]);
  expect(document.querySelector(".island")?.getAttribute("data-shape")).toBe("hidden");
  expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
  expect(footer.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(footer);
  expect(posts).toEqual(["/api/cells"]);
  await waitFor(() => expect(footer.getAttribute("aria-disabled")).toBe("true"));
  fireEvent.click(footer);
  expect(posts).toEqual(["/api/cells"]);
});
