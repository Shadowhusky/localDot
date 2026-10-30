// @vitest-environment jsdom
import type { PreviewOpened, PreviewsStatus } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import type { ComputerUpdate } from "../cells/useComputerUpdate.ts";
import { createApi } from "../lib/api.ts";
import { PreviewNotice } from "./PreviewNotice.tsx";
import { PreviewsScope, usePreviewsState } from "./PreviewsContext.tsx";
import { PreviewsPanel } from "./PreviewsPanel.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SESSION = "01JXYZ00000000000000000001";
const ORIGIN = "https://pc.example.ts.net:4900";
const READY: PreviewsStatus = {
  state: "ready",
  addresses: ["172.20.0.11"],
  previews: [],
  servers: [],
};
const OPENED: PreviewOpened = {
  preview: {
    id: "p1",
    target: "http://localhost:5173/",
    origin: ORIGIN,
    openedAt: "2026-10-08T09:00:00.000Z",
  },
  open: `${ORIGIN}/__localdot/preview#one-use-secret`,
};
const TEXT = "The app runs at http://localhost:5173/ now.";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// The daemon's previews routes, answered from the test; each call is kept.
function daemon(answers: { status?: () => Response; open?: () => Response } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") return answers.status?.() ?? json(READY);
    if (method === "POST") return answers.open?.() ?? json(OPENED);
    return new Response(null, { status: 204 });
  });
  return { api: createApi("token", { origin: "http://127.0.0.1:4750", fetchImpl }), calls };
}

function fakeTab() {
  const tab = {
    opener: window as unknown,
    closed: false,
    replaced: [] as string[],
    location: { replace: (url: string) => tab.replaced.push(url) },
    close: vi.fn(() => {
      tab.closed = true;
    }),
  };
  return tab;
}

function Harness({
  api,
  openSettings = () => {},
  update,
  panel = false,
}: {
  api: ReturnType<typeof daemon>["api"];
  openSettings?: (trigger: HTMLElement) => void;
  update?: ComputerUpdate;
  panel?: boolean;
}) {
  const previews = usePreviewsState(api, SESSION, { openSettings, update });
  return (
    <>
      <PreviewsScope value={previews}>
        <SafeMarkdown text={TEXT} />
        {panel && <PreviewsPanel active />}
      </PreviewsScope>
      <PreviewNotice previews={previews} />
    </>
  );
}

const chip = () => screen.getByRole("button", { name: "Open preview of localhost:5173" });

describe("opening a server dot printed", () => {
  it("opens the tab within the tap, cuts it from the app, then signs it in to the preview", async () => {
    const { api, calls } = daemon();
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<Harness api={api} />);
    expect(screen.getByText("http://localhost:5173/")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "http://localhost:5173/" })).toBeNull();
    await waitFor(() => expect(calls.some((call) => call.method === "GET")).toBe(true));
    fireEvent.click(chip());
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.replaced).toEqual([]);
    await waitFor(() => expect(tab.replaced).toEqual([OPENED.open]));
    expect(calls.find((call) => call.method === "POST")).toEqual({
      method: "POST",
      path: `/api/sessions/${SESSION}/previews`,
      body: { url: "http://localhost:5173/" },
    });
    expect(tab.close).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the tab it opened and says why beside the chip when the preview can't open", async () => {
    const { api } = daemon({
      open: () =>
        json(
          {
            state: "needs-tailscale",
            message: "Turn on Tailscale in Settings, then open the preview again.",
          },
          409,
        ),
    });
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const openSettings = vi.fn();
    render(<Harness api={api} openSettings={openSettings} />);
    fireEvent.click(chip());
    const notice = await screen.findByRole("dialog", { name: "Previews open over Tailscale" });
    expect(tab.close).toHaveBeenCalled();
    expect(notice.textContent).toContain("Turn on Tailscale in Settings");
    fireEvent.click(within(notice).getByRole("button", { name: "Open settings" }));
    expect(openSettings).toHaveBeenCalledWith(chip());
  });

  it("opens no tab when the computer is known to need an update, and offers the update", async () => {
    const { api, calls } = daemon({
      status: () => json({ ...READY, state: "needs-update", addresses: [] }),
    });
    const open = vi.spyOn(window, "open");
    const run = vi.fn();
    render(<Harness api={api} update={{ available: true, busy: false, error: null, run }} />);
    await waitFor(() => expect(calls.length).toBe(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    fireEvent.click(chip());
    const notice = await screen.findByRole("dialog", {
      name: "Update your computer to open previews",
    });
    expect(open).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(within(notice).getByRole("button", { name: "Update" }));
    expect(run).toHaveBeenCalled();
  });

  it("hands over the link when the browser keeps the tab from opening", async () => {
    const { api } = daemon();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<Harness api={api} />);
    fireEvent.click(chip());
    const notice = await screen.findByRole("dialog", { name: "Your preview is ready" });
    const link = within(notice).getByRole("link", { name: "Open preview" });
    expect(link.getAttribute("href")).toBe(OPENED.open);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("leaves dot's words as they were anywhere the owner's previews don't reach", () => {
    render(<SafeMarkdown text={TEXT} />);
    expect(screen.queryByRole("button", { name: /Open preview/ })).toBeNull();
    expect(screen.getByRole("link", { name: "http://localhost:5173/" }).getAttribute("href")).toBe(
      "http://localhost:5173/",
    );
  });

  it("offers a chip for an address in code, once per server", () => {
    const { api } = daemon();
    function Code() {
      const previews = usePreviewsState(api, SESSION, { openSettings: () => {} });
      return (
        <PreviewsScope value={previews}>
          <SafeMarkdown
            text={
              "Run `npm run dev`, then open `http://localhost:3000/`.\n\n```\nLocal:   http://localhost:5173/\nNetwork: http://172.20.0.11:5173/\n```"
            }
          />
        </PreviewsScope>
      );
    }
    render(<Code />);
    expect(
      screen
        .getAllByRole("button", { name: /^Open preview of / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Open preview of localhost:3000", "Open preview of localhost:5173"]);
  });
});

describe("the Previews list", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const LISTED: PreviewsStatus = {
    ...READY,
    previews: [
      OPENED.preview,
      { ...OPENED.preview, id: "p2", target: "https://thema.localhost:1355/" },
    ],
    servers: [
      {
        port: 1355,
        url: "https://localhost:1355/",
        name: "portless",
        state: "answering",
        seenAt: minutesAgo(0),
      },
      {
        port: 5173,
        url: "http://localhost:5173/",
        name: "node",
        title: "Shop",
        state: "answering",
        seenAt: minutesAgo(0),
      },
      {
        port: 8000,
        url: "http://localhost:8000/",
        name: "python3",
        state: "not-answering",
        seenAt: minutesAgo(5),
      },
    ],
  };

  it("lists the web apps in dot's computer by title, with how they answer, and opens one", async () => {
    const { api, calls } = daemon({ status: () => json(LISTED) });
    vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);
    render(<Harness api={api} panel />);
    const list = await screen.findByRole("region", { name: "Web apps in dot's computer" });
    expect(within(list).getByText("Shop")).toBeTruthy();
    expect(list.textContent).toContain("localhost:5173 · Running");
    expect(list.textContent).toContain("python3 · Not answering for 5 min");
    // A *.localhost site a server there names is an app of its own.
    expect(within(list).getByText("thema.localhost:1355")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Open preview of localhost:8000" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ port: 8000 }),
    );
    fireEvent.click(
      within(list).getByRole("button", { name: "Open preview of thema.localhost:1355" }),
    );
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "POST").at(-1)?.body).toEqual({
        url: "https://thema.localhost:1355/",
      }),
    );
  });

  it("copies a link that opens an app once, and shows it when the clipboard refuses", async () => {
    const { api } = daemon({ status: () => json(LISTED) });
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Harness api={api} panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy link to localhost:5173" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(OPENED.open));
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to localhost:5173" }));
    const notice = await screen.findByRole("dialog", { name: "Copy the link" });
    expect(notice.textContent).toContain(OPENED.open);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("signs every device out of the apps at once", async () => {
    const { api, calls } = daemon({ status: () => json(LISTED) });
    render(<Harness api={api} panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(
        calls
          .filter((call) => call.method === "DELETE")
          .map((call) => call.path)
          .sort(),
      ).toEqual([`/api/sessions/${SESSION}/previews/p1`, `/api/sessions/${SESSION}/previews/p2`]),
    );
  });

  it("says when no web app is running", async () => {
    const { api } = daemon();
    render(<Harness api={api} panel />);
    expect(await screen.findByText("No web apps running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("says to update the computer when it can't list its servers yet", async () => {
    const { api } = daemon({
      status: () =>
        json({
          ...READY,
          state: "needs-update",
          message: "Update your computer from Settings to open previews.",
        }),
    });
    render(<Harness api={api} panel />);
    expect(await screen.findByText("Update your computer to open previews")).toBeTruthy();
    expect(screen.getByText("Update your computer from Settings to open previews.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeTruthy();
  });
});
