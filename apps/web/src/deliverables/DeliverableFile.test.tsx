// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { showToast } from "../ui/Toast.tsx";
import { DeliverableFile } from "./DeliverableFile.tsx";
import { onReviseRequest } from "./revise-draft.ts";

vi.mock("../ui/Toast.tsx", async (original) => ({
  ...(await original<typeof import("../ui/Toast.tsx")>()),
  showToast: vi.fn(),
}));

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const RESULT = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R";
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.mocked(showToast).mockClear();
});
function daemon(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      const path = `${u.pathname}${u.search}`;
      calls.push(path);
      const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
      return hit ? hit[1]() : new Response("not found", { status: 404 });
    },
  });
  return { api, calls };
}
const versions = (name: string, n: number) =>
  Response.json({
    name,
    versions: Array.from({ length: n }, (_, i) => ({
      sessionId: ID,
      version: i + 1,
      label: i + 1,
      bytes: 10,
      resultId: RESULT,
      tMs: i * 1000,
      available: true,
    })),
  });
const downloads = {
  state: () => undefined,
  busy: false,
  request: vi.fn(async () => true),
  cancel: vi.fn(),
  sessionId: ID,
};
const file = (api: ReturnType<typeof daemon>["api"], name: string, version = 1, onMac = false) =>
  render(
    <ul>
      <DeliverableFile
        api={api}
        sessionId={ID}
        resultId={RESULT}
        file={{ name, path: `Documents/${name}`, bytes: 10, version }}
        downloads={downloads}
        refresh={1}
        defaultOpen
        onMac={onMac}
      />
    </ul>,
  );

describe("a handed-over file", () => {
  it("shows the first rows of a csv as a table", async () => {
    const d = daemon({
      "/versions": () => versions("totals.csv", 1),
      "/preview?v=1": () =>
        Response.json({
          kind: "table",
          rows: [
            ["Month", "Net"],
            ["Dec", "12000"],
          ],
          truncated: false,
        }),
    });
    file(d.api, "totals.csv");
    expect(await screen.findByRole("columnheader", { name: "Month" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "12000" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "First rows of totals.csv" })).toBeTruthy();
  });
  it("captions a page image made on the computer", async () => {
    const d = daemon({
      "/versions": () => versions("report.ods", 1),
      "/preview?v=1": () =>
        new Response(new Uint8Array([137, 80]), {
          headers: { "content-type": "image/png", "x-localdot-preview": "computer" },
        }),
    });
    file(d.api, "report.ods");
    expect(await screen.findByRole("img", { name: "Preview of report.ods" })).toBeTruthy();
    expect(screen.getByText("Preview made on your computer")).toBeTruthy();
  });
  it("says there is no preview for an svg, and never asks for one or draws it", async () => {
    const d = daemon({ "/versions": () => versions("diagram.svg", 1) });
    const view = file(d.api, "diagram.svg");
    expect(screen.getByText("No preview for this kind of file.")).toBeTruthy();
    await waitFor(() => expect(d.calls.length).toBeGreaterThan(0));
    expect(d.calls.some((path) => path.includes("/preview"))).toBe(false);
    expect(view.container.querySelectorAll("img, iframe, object, embed")).toHaveLength(0);
  });
  it("offers Try again after a failed preview and loads it again", async () => {
    let n = 0;
    const d = daemon({
      "/versions": () => versions("brief.docx", 1),
      "/preview?v=1": () =>
        n++ === 0
          ? Response.json({ kind: "none", reason: "failed" })
          : Response.json({ kind: "none", reason: "computer_off" }),
    });
    file(d.api, "brief.docx");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Turn on your computer to preview this file.")).toBeTruthy();
  });
  it("loads no picture for a closed row outside the chat, and one for a compact row", async () => {
    const d = daemon({
      "/versions": () => versions("chart.png", 1),
      "/preview?v=1": () =>
        new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } }),
    });
    const row = (compact: boolean) =>
      render(
        <ul>
          <DeliverableFile
            api={d.api}
            sessionId={ID}
            resultId={RESULT}
            file={{ name: "chart.png", path: "Documents/chart.png", bytes: 10, version: 1 }}
            downloads={downloads}
            refresh={1}
            onMac={false}
            compact={compact}
          />
        </ul>,
      );
    const activity = row(false);
    await waitFor(() => expect(d.calls.some((path) => path.endsWith("/versions"))).toBe(true));
    expect(d.calls.some((path) => path.includes("/preview"))).toBe(false);
    expect(activity.container.querySelector(".ui-file-tile img")).toBeNull();
    cleanup();
    const chat = row(true);
    await waitFor(() =>
      expect(chat.container.querySelector(".ui-file-tile img")?.getAttribute("src")).toBe(
        "blob:preview",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Show chart.png" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
  it("hides and shows its preview from its row", async () => {
    const d = daemon({
      "/versions": () => versions("notes.md", 1),
      "/preview?v=1": () =>
        Response.json({ kind: "text", format: "markdown", lines: ["# Notes"], truncated: false }),
    });
    file(d.api, "notes.md");
    expect(await screen.findByText("# Notes")).toBeTruthy();
    const row = screen.getByRole("button", { name: "Hide notes.md" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(
      screen.getByRole("button", { name: "Show notes.md" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
  it("chooses among versions only when there are two, and v1 loads its own preview", async () => {
    const d = daemon({
      "/versions": () => versions("totals.csv", 2),
      "/preview?v=2": () =>
        Response.json({ kind: "text", format: "plain", lines: ["two"], truncated: false }),
      "/preview?v=1": () =>
        Response.json({ kind: "text", format: "plain", lines: ["one"], truncated: false }),
    });
    file(d.api, "totals.csv", 2);
    expect(await screen.findByText("two")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Compare v1 → v2" })).toBeTruthy();
    const picker = await screen.findByRole("combobox", { name: "Version of totals.csv" });
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^v1/ }));
    await waitFor(() =>
      expect(d.calls).toContain(`/api/agent/sessions/${ID}/files/totals.csv/preview?v=1`),
    );
    expect(await screen.findByText("one")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compare v1 → v2" })).toBeNull();
  });
  it("asks the composer to revise the version it shows", async () => {
    const heard = vi.fn();
    const stop = onReviseRequest(heard);
    const d = daemon({ "/versions": () => versions("totals.csv", 2) });
    file(d.api, "totals.csv", 1);
    await screen.findByRole("combobox", { name: "Version of totals.csv" });
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(heard).toHaveBeenCalledWith({
      link: { sessionId: ID, name: "totals.csv", version: 1 },
      label: 1,
      newest: false,
    });
    stop();
  });
  it("opens a file on this Mac only where it can, and says what happened", async () => {
    const d = daemon({
      "/versions": () => versions("report.pdf", 1),
      "/open": () =>
        Response.json({ path: "~/Downloads/localDot/T (abc123)/report.pdf", reused: false }),
    });
    file(d.api, "report.pdf", 1, true);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf on your Mac" }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        title: "Opened report.pdf on your Mac",
        tone: "success",
      }),
    );
    cleanup();
    file(d.api, "diagram.svg", 1, true);
    expect(screen.queryByRole("button", { name: /on your Mac$/ })).toBeNull();
    cleanup();
    file(d.api, "report.pdf", 1, false);
    expect(screen.queryByRole("button", { name: /on your Mac$/ })).toBeNull();
  });
  it("passes on the daemon's reason when Open on Mac is refused", async () => {
    const d = daemon({
      "/open": () =>
        new Response("Open on Mac works only in localDot on this Mac.", { status: 403 }),
    });
    file(d.api, "report.pdf", 1, true);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf on your Mac" }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        title: "Open on Mac works only in localDot on this Mac.",
        tone: "danger",
      }),
    );
  });
});
