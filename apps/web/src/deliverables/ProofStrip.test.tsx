// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ProofStrip } from "./ProofStrip.tsx";
import { useProof } from "./useProof.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const R = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R";
const F = (n: number) => `01J9ZQ3V8Y7X6W5T4S3R2Q1PF${n}`;
afterEach(cleanup);
const FRAMES = [
  { role: "start", frameId: F(1), tMs: 0 },
  { role: "change", frameId: F(2), tMs: 40_000 },
  { role: "end", frameId: F(3), tMs: 101_000 },
];
const proofReply = (recording: string, checked: string | null, frames = FRAMES) => ({
  recording,
  results: [
    {
      resultId: R,
      frames,
      checked,
      startMs: 0,
      endMs: 102_000,
    },
  ],
});
function strip(
  recording: string,
  checked: string | null,
  frames = FRAMES,
  answered: Promise<void> = Promise.resolve(),
  onReplay?: () => void,
) {
  const pictures: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      if (!String(url).endsWith("/proof")) {
        pictures.push(new URL(String(url)).pathname);
        return new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } });
      }
      await answered;
      return Response.json(proofReply(recording, checked, frames));
    },
  });
  function Strip() {
    return (
      <ProofStrip
        api={api}
        sessionId={ID}
        resultId={R}
        proof={useProof(api, ID, 1)}
        onReplay={onReplay}
      />
    );
  }
  return { ...render(<Strip />), pictures };
}
const more = () =>
  act(async () => screen.getByRole("button", { name: "More for this replay" }).click());

describe("proof strip", () => {
  it("shows the replay on one row: its last moment, its length and what dot checked", async () => {
    const { pictures, container } = strip("complete", "opens, 4 sheets");
    const row = await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(row.textContent).toContain("Replay · 1:42");
    expect(row.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(row.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Checked: opens, 4 sheets",
    );
    // The three moments stay in Replay; the row pictures only the last.
    expect(screen.queryByRole("button", { name: "Watch from the key change" })).toBeNull();
    await waitFor(() => expect(pictures).toEqual([`/api/sessions/${ID}/thumbs/${F(3)}`]));
    expect(container.querySelectorAll(".ui-file-row")).toHaveLength(1);
    await more();
    expect(screen.getByRole("menuitem", { name: "Export proof video" })).toBeTruthy();
  });
  it("offers no menu without a recording to export, and no check when there is none", async () => {
    strip("none", null);
    await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(screen.queryByRole("button", { name: "More for this replay" })).toBeNull();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
  });
  it("keeps one row from before the answer, so the result never jumps", async () => {
    let answer = () => {};
    const onReplay = vi.fn();
    const { container } = strip(
      "complete",
      null,
      [],
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
      onReplay,
    );
    await act(async () => {});
    const before = container.querySelector(".ui-file-row");
    fireEvent.click(screen.getByRole("button", { name: "Replay this task" }));
    expect(onReplay).toHaveBeenCalledOnce();
    answer();
    await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(container.querySelector(".ui-file-row")).toBe(before);
  });
  it("holds nothing before the answer when there is no Replay to open", async () => {
    const { container } = strip("complete", null, [], new Promise<void>(() => {}));
    await act(async () => {});
    expect(container.childElementCount).toBe(0);
  });
  it("offers Export proof video for a turn without screenshots, since the recording covers it", async () => {
    const { pictures } = strip("complete", null, []);
    await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(pictures).toEqual([]);
    await more();
    expect(screen.getByRole("menuitem", { name: "Export proof video" })).toBeTruthy();
  });
  it("opens Replay where the work began, and Export at this result's part of the recording", async () => {
    strip("complete", null);
    fireEvent.click(await screen.findByRole("button", { name: "Watch replay (1:42)" }));
    let params = new URLSearchParams(window.location.search);
    expect([params.get("replay"), params.get("t"), params.get("export")]).toEqual([ID, "0", null]);
    await more();
    await act(async () => screen.getByRole("menuitem", { name: "Export proof video" }).click());
    params = new URLSearchParams(window.location.search);
    expect([params.get("t"), params.get("export")]).toEqual(["0", "0-102000"]);
  });
});
describe("proof requests", () => {
  it("asks once per task and answer, and draws a known answer at once", async () => {
    let asked = 0;
    const api = createApi("a".repeat(43), {
      origin: "http://127.0.0.1:4750",
      fetchImpl: async () => {
        asked++;
        return Response.json(proofReply("complete", null));
      },
    });
    const first = renderHook(() => useProof(api, ID, 1));
    const second = renderHook(() => useProof(api, ID, 1));
    await waitFor(() => expect(first.result.current.state).toBe("ready"));
    await waitFor(() => expect(second.result.current.state).toBe("ready"));
    expect(asked).toBe(1);
    const later = renderHook(() => useProof(api, ID, 1));
    expect(later.result.current.state).toBe("ready");
    await act(async () => {});
    expect(asked).toBe(1);
  });
});
