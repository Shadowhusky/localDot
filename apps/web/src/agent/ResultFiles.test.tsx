// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { disposition } from "./file-transfer.ts";
import { ResultFiles } from "./ResultFiles.tsx";

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
describe("user-activated inert result downloads", () => {
  it("keeps every schema-admitted result file available without automatically downloading any", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(
      <ResultFiles
        api={apiFor(fetchImpl)}
        sessionId={SESSION}
        ended={false}
        idle={false}
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
    expect(screen.getAllByRole("button", { name: /^Download report-/ })).toHaveLength(32);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });
  it("uses only authenticated session/name, never the model path, and releases its inert object URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response()),
      api = apiFor(fetchImpl);
    const view = render(
      <ResultFiles api={api} sessionId={SESSION} results={results} ended={false} idle={false} />,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download report.html" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
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
    const view = render(
      <ResultFiles api={api} sessionId={SESSION} results={results} ended={false} idle={false} />,
    );
    act(() => {
      const button = screen.getByRole("button", { name: "Download report.html" });
      button.click();
      button.click();
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    view.rerender(
      <ResultFiles api={api} sessionId={OTHER} results={results} ended={false} idle={false} />,
    );
    await act(async () => late.resolve(response()));
    expect(created).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
    expect(screen.queryByText(/Download requested/)).toBeNull();
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
    const api = apiFor(
      async () =>
        new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": disposition("report.html"),
            "x-content-type-options": "nosniff",
          },
        }),
    );
    render(
      <ResultFiles api={api} sessionId={SESSION} results={results} ended={false} idle={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download report.html" }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(cancelled).toBe(true));
    expect(created).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
});
