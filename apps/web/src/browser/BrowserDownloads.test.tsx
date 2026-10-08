// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import { createApi } from "../lib/api.ts";
import { BrowserDownloads } from "./BrowserDownloads.tsx";
import { changeDownload, listDownloads, releaseRequest } from "./download-api.ts";

const parent = "01J00000000000000000000001",
  other = "01J00000000000000000000002";
const held: QuarantineItem = {
  id: "01J00000000000000000000003",
  version: 1,
  parentCellId: parent,
  browserCellId: "01J00000000000000000000004",
  browserInstance: "10000000-0000-4000-8000-000000000001",
  sessionId: "01J00000000000000000000005",
  name: "report.pdf",
  source: "files.example.test",
  bytes: 12345,
  sha256: "a".repeat(64),
  kind: "document",
  createdAt: Date.now(),
  revision: 1,
  state: "held",
};
const releasing: QuarantineItem = {
  ...held,
  state: "releasing",
  revision: 2,
  release: { transferId: "01J00000000000000000000006", approvedRevision: 1 },
};
const released: QuarantineItem = {
  ...releasing,
  state: "released",
  revision: 3,
  receipt: {
    transferId: releasing.release.transferId,
    parentCellId: parent,
    name: held.name,
    bytes: held.bytes,
    sha256: held.sha256,
    path: "~/Downloads/report.pdf",
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture(initial: QuarantineItem = held) {
  let current = initial;
  const post = vi.fn(async (): Promise<QuarantineItem> => released);
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") {
      current = await post();
      return Response.json(current);
    }
    return Response.json({ items: [current] });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  return {
    api,
    post,
    fetchImpl,
    update: (value: QuarantineItem) => {
      current = value;
    },
  };
}

describe("browser download review controls", () => {
  it("shows bounded metadata without releasing until the exact portal decision is confirmed", async () => {
    const f = fixture();
    const { container } = render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    await screen.findByText("report.pdf");
    expect(f.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review & release" }));
    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(within(dialog).getByText(held.sha256)).toBeTruthy();
    expect(within(dialog).getByText("This computer’s Downloads folder")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Release once" }));
    await screen.findByText("Saved report.pdf to ~/Downloads/report.pdf.");
    const [, request] = f.fetchImpl.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
    expect(JSON.parse(request?.body as string)).toEqual(releaseRequest(held));
    expect(request?.headers).toEqual({
      authorization: "Bearer fixture",
      "content-type": "application/json",
    });
    expect(f.post).toHaveBeenCalledOnce();
  });
  it("cancel closes the floating decision without sending an effect", async () => {
    const f = fixture();
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Review & release" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.post).not.toHaveBeenCalled();
  });
  it("reconciles an uncertain delivery with the original approved revision", async () => {
    const f = fixture(releasing);
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Check delivery" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Check delivery" }),
    );
    await screen.findByText("Saved report.pdf to ~/Downloads/report.pdf.");
    const [, request] = f.fetchImpl.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
    expect(JSON.parse(request?.body as string).revision).toBe(1);
  });
  it("requires confirmation before discarding and sends the current revision", async () => {
    const f = fixture();
    f.post.mockResolvedValue({ ...held, revision: 2, state: "discarded" });
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(f.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard download" }));
    await screen.findByText("Discarded report.pdf.");
    expect(screen.queryByText("report.pdf")).toBeNull();
    const [url, request] = f.fetchImpl.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
    expect(String(url)).toMatch(/\/discard$/u);
    expect(JSON.parse(request?.body as string)).toEqual({ revision: 1 });
  });
  it("disables stale decisions after the listed file changes", async () => {
    const f = fixture();
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Review & release" }));
    f.update(released);
    fireEvent.click(screen.getByRole("button", { name: "Refresh downloads" }));
    await screen.findByText("This download changed. Cancel and refresh its status.");
    expect(
      (screen.getByRole("button", { name: "Release once" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
  });
  it("does not repeat an uncertain write while refreshing its durable state", async () => {
    const f = fixture();
    f.post.mockImplementation(async () => {
      f.update(releasing);
      throw new Error("lost response");
    });
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Review & release" }));
    fireEvent.click(screen.getByRole("button", { name: "Release once" }));
    await screen.findByText(/The change was not confirmed/);
    await screen.findByRole("button", { name: "Check delivery" });
    expect(f.post).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight mutation on computer change and ignores its late receipt", async () => {
    const f = fixture();
    const receipt = Promise.withResolvers<typeof released>();
    f.post.mockImplementation(() => receipt.promise);
    const view = render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
    fireEvent.click(await screen.findByRole("button", { name: "Review & release" }));
    fireEvent.click(screen.getByRole("button", { name: "Release once" }));
    await waitFor(() => expect(f.post).toHaveBeenCalledOnce());
    const [, request] = f.fetchImpl.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
    view.rerender(<BrowserDownloads api={f.api} cellId={other} releaseReady />);
    expect(request?.signal?.aborted).toBe(true);
    await act(async () => receipt.resolve(released));
    expect(screen.queryByText("Saved report.pdf to ~/Downloads/report.pdf.")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps release unavailable for a stopped computer while allowing discard review", async () => {
    const f = fixture();
    render(<BrowserDownloads api={f.api} cellId={parent} releaseReady={false} />);
    const button = await screen.findByRole("button", { name: "Review & release" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Discard" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });
  it("rejects a forged ownership reply before displaying or trusting it", async () => {
    const f = fixture({ ...held, parentCellId: other });
    await expect(listDownloads(f.api, parent, new AbortController().signal)).rejects.toThrow();
    f.post.mockResolvedValue({
      ...released,
      sha256: "b".repeat(64),
      receipt: { ...released.receipt, sha256: "b".repeat(64) },
    });
    await expect(
      changeDownload(f.api, parent, held, "release", new AbortController().signal),
    ).rejects.toThrow();
  });
});
it("counts one kept download as one file", async () => {
  const f = fixture(released);
  render(<BrowserDownloads api={f.api} cellId={parent} releaseReady />);
  await screen.findByText(/Saved to ~\/Downloads\/report\.pdf/);
  expect(screen.getByText("1 file")).toBeTruthy();
});
describe("download list refresh", () => {
  const FAILED = "Downloads could not be refreshed. Check the computer and try again.";
  const lists = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
    fetchImpl.mock.calls.filter(([, init]) => init?.method !== "POST").length;
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("polls only while a file can be released or is waiting for review", async () => {
    vi.useFakeTimers();
    let items: QuarantineItem[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ items }));
    const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
    const view = render(<BrowserDownloads api={api} cellId={parent} releaseReady={false} />);
    await wait(10_000);
    expect(lists(fetchImpl)).toBe(1);
    view.rerender(<BrowserDownloads api={api} cellId={parent} releaseReady />);
    await wait(4_100);
    expect(lists(fetchImpl)).toBeGreaterThanOrEqual(3);
    items = [held];
    await wait(2_100);
    view.rerender(<BrowserDownloads api={api} cellId={parent} releaseReady={false} />);
    const counted = lists(fetchImpl);
    await wait(4_100);
    expect(lists(fetchImpl)).toBeGreaterThan(counted);
    items = [];
    await wait(2_100);
    const settled = lists(fetchImpl);
    await wait(10_000);
    expect(lists(fetchImpl)).toBe(settled);
  });
  it("shows no refresh error before the first list and clears it after the next success", async () => {
    vi.useFakeTimers();
    let ok = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok ? Response.json({ items: [held] }) : new Response("starting", { status: 503 }),
    );
    const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
    render(<BrowserDownloads api={api} cellId={parent} releaseReady />);
    await wait(6_100);
    expect(lists(fetchImpl)).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(FAILED)).toBeNull();
    ok = true;
    await wait(2_100);
    expect(screen.getByText("report.pdf")).toBeTruthy();
    ok = false;
    await wait(2_100);
    expect(screen.getByText(FAILED)).toBeTruthy();
    ok = true;
    await wait(2_100);
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
