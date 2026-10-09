// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type Knowledge, useKnowledge } from "../agent/useKnowledge.ts";
import { createApi } from "../lib/api.ts";
import { KnowledgeSection } from "./KnowledgeSection.tsx";
import { knownFixture } from "./testing.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows skills as plain text without editors", () => {
  const knowledge: Knowledge = {
    skills: [{ name: "report", description: "<img src=x>", source: "user" }],
    skillsPhase: "ready",
    memory: null,
    memoryPhase: "unknown",
    reloadSkills: vi.fn(),
    rereadMemory: vi.fn(),
  };
  render(<KnowledgeSection knowledge={knowledge} known={knownFixture()} />);
  const skills = screen.getByRole("list", { name: "Skills" });
  expect(skills.querySelectorAll("form,input,textarea,button,img,b")).toHaveLength(0);
  expect(screen.getByText("<img src=x>")).toBeTruthy();
  expect(screen.getByText("Yours")).toBeTruthy();
});

function Fixture({ api }: { api: ReturnType<typeof createApi> }) {
  return <KnowledgeSection knowledge={useKnowledge(api, null, true)} known={knownFixture()} />;
}

it.each(["hidden", "offline"] as const)(
  "offers Show the file again after a read cancelled by going %s",
  async (kind) => {
    let hidden = false,
      online = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const late = Promise.withResolvers<Response>();
    const requests: { path: string; signal?: AbortSignal | null }[] = [];
    const api = createApi("inert-review-token", {
      origin: "https://owned.invalid",
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, signal: init?.signal });
        return path.endsWith("/skills") ? Response.json([]) : late.promise;
      },
    });
    render(<Fixture api={api} />);
    await waitFor(() => expect(screen.getByText("No skills yet.")).toBeTruthy());
    const show = () => screen.getByRole("button", { name: /^Show the file/ });
    act(() => show().click());
    act(() => show().click());
    expect(requests, "one read while one is pending").toHaveLength(2);
    await act(async () => {
      if (kind === "hidden") {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        online = false;
        window.dispatchEvent(new Event("offline"));
      }
    });
    expect(requests[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      hidden = false;
      online = true;
      if (kind === "hidden") document.dispatchEvent(new Event("visibilitychange"));
      else window.dispatchEvent(new Event("online"));
      late.resolve(Response.json({ user: "stale retired result", memory: "stale" }));
    });
    expect(document.body.textContent).not.toContain("stale retired result");
    expect(requests, "no automatic replay of cancelled read").toHaveLength(2);
    act(() => show().click());
    expect(requests, "the cancelled request leaves a usable explicit retry").toHaveLength(3);
  },
);
