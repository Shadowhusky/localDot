// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { createApi } from "../lib/api.ts";
import { disposition } from "./file-transfer.ts";
import type { AgentResult } from "./model.ts";
import { ResultCard, useResultDownloads } from "./ResultFiles.tsx";

function ResultFiles({
  api,
  sessionId,
  results,
}: {
  api: ApiClient;
  sessionId: string | null;
  results: AgentResult[];
}) {
  const downloads = useResultDownloads(api, sessionId, results);
  return (
    <>
      {results.map((result) => (
        <ResultCard key={result.id} result={result} downloads={downloads} />
      ))}
    </>
  );
}

const SESSION = "01JXYZ0000000000000000SESS",
  OTHER = "01JXYZ00000000000000000002";
const results = [
  {
    id: "result-id",
    summary: "Sample",
    files: [{ name: "report.html", path: "https://evil.invalid/executable", bytes: 12 }],
  },
];
const response = () =>
  new Response("<script>x</script>", {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": disposition("report.html"),
      "x-content-type-options": "nosniff",
    },
  });
const created = vi.fn((_blob: Blob) => "blob:owned-result"),
  revoked = vi.fn((_url: string) => undefined),
  clicked = vi.fn();
const NativeURL = URL;
beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = created;
      static revokeObjectURL = revoked;
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(clicked);
  created.mockClear();
  revoked.mockClear();
  clicked.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const apiFor = (fetchImpl: typeof fetch) =>
  createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
// A card also reads each file's versions, previews and the task's proof; only these fetch a file.
const downloadPath = (url: string) =>
  /\/files\/[^/]+(?:\/versions\/\d+)?$/.test(new URL(url).pathname);
const downloadsOf = (fetchImpl: { mock: { calls: unknown[][] } }) =>
  fetchImpl.mock.calls.map((call) => String(call[0])).filter(downloadPath);
describe("user-activated inert result downloads", () => {
  it("keeps every schema-admitted result file available without automatically downloading any", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(
      <ResultFiles
        api={apiFor(fetchImpl)}
        sessionId={SESSION}
        results={[
          {
            id: "many-result-files",
            summary: "Sample",
            files: Array.from({ length: 32 }, (_, i) => ({
              name: `report-${i}.txt`,
              path: `untrusted/${i}`,
              bytes: 1,
            })),
          },
        ]}
      />,
    );
    // The first three show and the rest are one press away.
    fireEvent.click(screen.getByText("Show 29 more"));
    expect(screen.getAllByRole("button", { name: /^Download report-/ })).toHaveLength(32);
    expect(downloadsOf(fetchImpl)).toEqual([]);
    expect(created).not.toHaveBeenCalled();
  });
  it("uses only authenticated session/name, never the model path, and releases its inert object URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response()),
      api = apiFor(fetchImpl);
    const view = render(<ResultFiles api={api} sessionId={SESSION} results={results} />);
    expect(downloadsOf(fetchImpl)).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download report.html" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(downloadsOf(fetchImpl)[0]).toBe(
      `http://127.0.0.1:4747/api/agent/sessions/${SESSION}/files/report.html`,
    );
    expect(created.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(document.querySelectorAll("script,iframe,object,embed,a")).toHaveLength(0);
    expect(created).toHaveBeenCalledOnce();
    view.unmount();
    expect(revoked).toHaveBeenCalledWith("blob:owned-result");
  });
  it("synchronously excludes duplicate downloads and discards late completion after session replacement", async () => {
    const late = Promise.withResolvers<Response>(),
      fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
      api = apiFor(fetchImpl);
    const view = render(<ResultFiles api={api} sessionId={SESSION} results={results} />);
    act(() => {
      const button = screen.getByRole("button", { name: "Download report.html" });
      button.click();
      button.click();
    });
    expect(downloadsOf(fetchImpl)).toHaveLength(1);
    view.rerender(<ResultFiles api={api} sessionId={OTHER} results={results} />);
    await act(async () => late.resolve(response()));
    expect(created).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
    expect(screen.queryByText(/downloaded/)).toBeNull();
  });
  it("cancels an admitted download during body consumption without creating a URL", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const api = apiFor(async (url) =>
      downloadPath(String(url))
        ? new Response(body, {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": disposition("report.html"),
              "x-content-type-options": "nosniff",
            },
          })
        : new Response("not found", { status: 404 }),
    );
    render(<ResultFiles api={api} sessionId={SESSION} results={results} />);
    fireEvent.click(screen.getByRole("button", { name: "Download report.html" }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(cancelled).toBe(true));
    expect(created).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});

describe("the result card", () => {
  it("downloads the version its card shows, not the newest copy a later result left", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      downloadPath(String(url))
        ? new Response("v1", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": disposition("totals.csv"),
              "x-content-type-options": "nosniff",
            },
          })
        : new Response("not found", { status: 404 }),
    );
    const earlier = {
      id: "first",
      summary: "First pass",
      files: [{ name: "totals.csv", path: "Documents/totals.csv", bytes: 2, version: 1 }],
    };
    render(<ResultFiles api={apiFor(fetchImpl)} sessionId={SESSION} results={[earlier]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download totals.csv" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(downloadsOf(fetchImpl)).toEqual([
      `http://127.0.0.1:4747/api/agent/sessions/${SESSION}/files/totals.csv/versions/1`,
    ]);
  });
  it("keeps multiline result text plain and sizes each file", () => {
    const result = {
      id: "r",
      summary: "First line\n<script>plain text</script>\n中文",
      files: [
        { name: "a-very-long-report-name-that-runs-on.md", path: "ignored", bytes: 48 },
        { name: "totals.csv", path: "ignored", bytes: 2048 },
      ],
    };
    const view = render(
      <ResultFiles api={apiFor(vi.fn<typeof fetch>())} sessionId={SESSION} results={[result]} />,
    );
    expect(view.container.querySelector(".result-summary")?.textContent).toBe(result.summary);
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText("48 bytes")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByTitle(result.files[0]?.name ?? "").textContent).toBe(result.files[0]?.name);
    expect(screen.getByRole("button", { name: "Download all 2 files" })).toBeTruthy();
  });

  it("downloads every file in turn from Download all", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (url) =>
        new Response("x", {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": disposition(String(url).endsWith("b.txt") ? "b.txt" : "a.txt"),
            "x-content-type-options": "nosniff",
          },
        }),
    );
    render(
      <ResultFiles
        api={apiFor(fetchImpl)}
        sessionId={SESSION}
        results={[
          {
            id: "r",
            summary: "Two files",
            files: [
              { name: "a.txt", path: "a", bytes: 1 },
              { name: "b.txt", path: "b", bytes: 1 },
            ],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download all 2 files" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(2));
    expect(downloadsOf(fetchImpl).map((url) => url.split("/").at(-1))).toEqual(["a.txt", "b.txt"]);
  });

  it("starts every preview closed and folds the files after the first three", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
    const files = ["a.md", "b.csv", "c.txt", "d.md", "e.md"].map((name) => ({
      name,
      path: name,
      bytes: 1,
    }));
    render(
      <ResultFiles
        api={apiFor(fetchImpl)}
        sessionId={SESSION}
        results={[{ id: "r", summary: "Five files", files }]}
      />,
    );
    const list = screen.getByRole("list", { name: "Files in result r" });
    const rows = () => list.querySelectorAll(":scope > li");
    expect(rows()).toHaveLength(3);
    expect(
      [...list.querySelectorAll("[aria-expanded]")].map((row) => [
        row.getAttribute("aria-label"),
        row.getAttribute("aria-expanded"),
      ]),
    ).toEqual([
      ["Show a.md", "false"],
      ["Show b.csv", "false"],
      ["Show c.txt", "false"],
    ]);
    const more = screen.getByRole("button", { name: "Show 2 more files" });
    expect(more.textContent).toBe("Show 2 more");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(list.id);
    fireEvent.click(more);
    expect(rows()).toHaveLength(5);
    expect(more.getAttribute("aria-label")).toBe("Show fewer files");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(more);
    expect(rows()).toHaveLength(3);
    await act(async () => {});
    const asked = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(asked.filter((url) => url.includes("/preview"))).toEqual([]);
  });

  it("lists four files whole rather than fold away one", () => {
    const files = ["a.md", "b.md", "c.md", "d.md"].map((name) => ({ name, path: name, bytes: 1 }));
    render(
      <ResultFiles
        api={apiFor(vi.fn<typeof fetch>(async () => new Response("", { status: 404 })))}
        sessionId={SESSION}
        results={[{ id: "r", summary: "Four files", files }]}
      />,
    );
    expect(
      screen.getByRole("list", { name: "Files in result r" }).querySelectorAll(":scope > li"),
    ).toHaveLength(4);
    expect(screen.queryByText(/^Show \d+ more$/)).toBeNull();
  });

  it("puts an image's own picture on its tile while its row stays closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/chart.png/preview")
        ? new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { "content-type": "image/png" },
          })
        : new Response("not found", { status: 404 }),
    );
    const { container } = render(
      <ResultFiles
        api={apiFor(fetchImpl)}
        sessionId={SESSION}
        results={[
          {
            id: "r",
            summary: "A chart and its notes",
            files: [
              { name: "chart.png", path: "chart.png", bytes: 4 },
              { name: "notes.md", path: "notes.md", bytes: 1 },
            ],
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector(".ui-file-tile > img")?.getAttribute("src")).toBe(
        "blob:owned-result",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Show chart.png" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      fetchImpl.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("/preview")),
    ).toEqual([`http://127.0.0.1:4747/api/agent/sessions/${SESSION}/files/chart.png/preview`]);
    expect(downloadsOf(fetchImpl)).toEqual([]);
  });

  it("still lists a result's files, with nothing to do, when its task is gone", () => {
    function Gone() {
      const downloads = useResultDownloads(null, null, results);
      return <ResultCard result={results[0] as AgentResult} downloads={downloads} />;
    }
    render(<Gone />);
    const download = screen.getByRole("button", { name: "Download report.html" });
    expect(download.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("12 bytes")).toBeTruthy();
  });
  it("offers a replay of the task only when given one", () => {
    const onReplay = vi.fn();
    const result = { id: "r", summary: "Done", files: [] };
    const view = render(
      <ResultCard
        result={result}
        downloads={{} as Parameters<typeof ResultCard>[0]["downloads"]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Replay this task" })).toBeNull();
    view.rerender(
      <ResultCard
        result={result}
        downloads={{} as Parameters<typeof ResultCard>[0]["downloads"]}
        onReplay={onReplay}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Replay this task" }));
    expect(onReplay).toHaveBeenCalledOnce();
  });
});
