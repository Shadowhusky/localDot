// @vitest-environment jsdom
import type { PreviewOpened, PreviewsStatus, ResultPreview } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import type { ComputerUpdate } from "../cells/useComputerUpdate.ts";
import { createApi } from "../lib/api.ts";
import { newestOffers, PreviewCard } from "./PreviewCard.tsx";
import { PreviewNotice } from "./PreviewNotice.tsx";
import { PreviewsScope, usePreviewsState } from "./PreviewsContext.tsx";
import { arrangeApps, PreviewsPanel } from "./PreviewsPanel.tsx";

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
    // A *.localhost site a server there names is an app of its own.
    expect(within(list).getByText("thema.localhost:1355")).toBeTruthy();
    // One that stopped answering is folded away, and can still be tried.
    expect(list.textContent).not.toContain("python3");
    fireEvent.click(screen.getByRole("button", { name: /Replaced or not answering/ }));
    expect(screen.getByText("Not answering for 5 min").parentElement?.textContent).toContain(
      "python3 · ",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preview of localhost:8000" }));
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

  it("leads with this conversation's apps and folds the rest", () => {
    const server = (port: number, more: Partial<PreviewsStatus["servers"][number]>) => ({
      port,
      url: `http://localhost:${port}/`,
      state: "answering" as const,
      seenAt: minutesAgo(0),
      ...more,
    });
    const app = (entry: PreviewsStatus["servers"][number]) => ({
      address: `localhost:${entry.port}`,
      request: { port: entry.port },
      server: entry,
      state: entry.state,
    });
    const apps = [
      server(1, { here: true }),
      server(2, { here: false }),
      server(3, { here: true, older: true }),
      server(4, { here: true, state: "not-answering" }),
      // A computer that can't say who started it keeps it in front.
      server(5, {}),
    ].map(app);
    const { running, others, fading } = arrangeApps(apps);
    expect(running.map((entry) => entry.server.port)).toEqual([1, 5]);
    expect(others.map((entry) => entry.server.port)).toEqual([2]);
    expect(fading.map((entry) => entry.server.port)).toEqual([3, 4]);
  });

  it("says a *.localhost site has gone even while its proxy runs", async () => {
    const { api } = daemon({
      status: () =>
        json({
          ...READY,
          previews: [
            {
              ...OPENED.preview,
              id: "p2",
              target: "https://old.localhost:1355/",
              state: "not-answering",
            },
          ],
          servers: [
            {
              port: 1355,
              url: "https://localhost:1355/",
              name: "portless",
              state: "answering",
              seenAt: minutesAgo(0),
            },
          ],
        }),
    });
    render(<Harness api={api} panel />);
    const list = await screen.findByRole("region", { name: "Web apps in dot's computer" });
    expect(list.textContent).toContain("localhost:1355");
    expect(list.textContent).not.toContain("old.localhost");
    fireEvent.click(screen.getByRole("button", { name: /Replaced or not answering/ }));
    expect(screen.getByRole("button", { name: "Open preview of old.localhost:1355" })).toBeTruthy();
    // A name on a port its proxy serves has no Stop of its own: that would stop them all.
    expect(screen.queryByRole("button", { name: "Stop old.localhost:1355" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop localhost:1355" })).toBeTruthy();
  });

  it("stops a server for good, and says when it couldn't", async () => {
    const answers: Response[] = [
      new Response(null, { status: 204 }),
      json({ message: "localDot couldn't stop it. Try again in a moment." }, 409),
    ];
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "DELETE") {
        calls.push(path);
        return answers.shift() ?? new Response(null, { status: 204 });
      }
      return json(LISTED);
    });
    const api = createApi("token", { origin: "http://127.0.0.1:4750", fetchImpl });
    render(<Harness api={api} panel />);
    const stop = await screen.findByRole("button", { name: "Stop localhost:5173" });
    fireEvent.click(stop);
    await waitFor(() => expect(calls).toEqual([`/api/sessions/${SESSION}/previews/servers/5173`]));
    await waitFor(() => expect(stop.getAttribute("aria-busy")).toBeNull());
    fireEvent.click(stop);
    expect(await screen.findByText(/couldn't stop it/)).toBeTruthy();
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

describe("the preview a reply comes with", () => {
  const offer: ResultPreview = {
    port: 5173,
    url: "http://localhost:5173/",
    title: "Shop",
    project: "shop",
    name: "node",
  };
  const running = {
    port: 5173,
    url: "http://localhost:5173/",
    name: "node",
    title: "Shop",
    state: "answering",
    seenAt: "2026-10-08T09:00:00.000Z",
  };
  function Card({ api }: { api: ReturnType<typeof createApi> }) {
    const previews = usePreviewsState(api, SESSION, { openSettings: () => {} });
    return (
      <PreviewsScope value={previews}>
        <PreviewCard offer={offer} />
      </PreviewsScope>
    );
  }

  it("opens the app while it runs, from a link made at the tap", async () => {
    const { api, calls } = daemon({ status: () => json({ ...READY, servers: [running] }) });
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<Card api={api} />);
    expect(await screen.findByText("localhost:5173 · Running")).toBeTruthy();
    expect(screen.getByText("Shop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open preview of localhost:5173" }));
    await waitFor(() => expect(tab.replaced).toEqual([OPENED.open]));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ url: offer.url });
  });

  it.each([
    ["it has stopped", { ...READY }, "Stopped. Ask dot to start it again."],
    [
      "another program took its port",
      { ...READY, servers: [{ ...running, name: "python3" }] },
      "Stopped. Ask dot to start it again.",
    ],
    [
      "its computer is off",
      { ...READY, state: "computer-off", message: "Turn on your computer." },
      "Your computer is off",
    ],
  ])("offers no link once %s", async (_case, status, words) => {
    const { api } = daemon({ status: () => json(status) });
    render(<Card api={api} />);
    expect(await screen.findByText(new RegExp(words.replace(".", "\\.")))).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open preview/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
  });

  it("doesn't claim it stopped when its computer can't be asked", async () => {
    const { api } = daemon({ status: () => json({ message: "unknown" }, 404) });
    render(<Card api={api} />);
    expect(await screen.findByText(/Can't be checked right now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open preview/ })).toBeNull();
  });

  it("says when it isn't answering, and lets the owner try", async () => {
    const { api } = daemon({
      status: () => json({ ...READY, servers: [{ ...running, state: "not-answering" }] }),
    });
    render(<Card api={api} />);
    expect(await screen.findByText("localhost:5173 · Not answering")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open preview/ })).toBeTruthy();
  });

  it("is read again while it is on show, so a stop shows without a refresh", async () => {
    let status: PreviewsStatus = { ...READY, servers: [running as never] };
    const { api } = daemon({ status: () => json(status) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Card api={api} />);
      expect(await screen.findByText("localhost:5173 · Running")).toBeTruthy();
      status = { ...READY };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(await screen.findByText(/Stopped/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing where previews don't open: a shared link, or Replay", () => {
    const { container } = render(<PreviewCard offer={offer} />);
    expect(container.textContent).toBe("");
  });

  it("offers each app once, on the newest reply that does", () => {
    const shop = { port: 5173, url: "http://localhost:5173/" };
    const blog = { port: 4000, url: "http://localhost:4000/" };
    const result = (id: string, previews?: ResultPreview[]) => ({
      id,
      summary: "",
      files: [],
      ...(previews ? { previews } : {}),
    });
    const offers = newestOffers([
      result("first", [shop]),
      result("second", [shop, blog]),
      result("quiet"),
      result("third", [shop]),
    ]);
    expect(offers.get("first")).toBeUndefined();
    expect(offers.get("second")).toEqual([blog]);
    expect(offers.get("quiet")).toBeUndefined();
    expect(offers.get("third")).toEqual([shop]);
  });
});
