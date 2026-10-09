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
import { afterEach, describe, expect, it } from "vitest";
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
) {
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      if (!String(url).endsWith("/proof"))
        return new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } });
      await answered;
      return Response.json(proofReply(recording, checked, frames));
    },
  });
  function Strip() {
    return <ProofStrip api={api} sessionId={ID} resultId={R} proof={useProof(api, ID, 1)} />;
  }
  return render(<Strip />);
}
describe("proof strip", () => {
  it("shows start, key change and end with Watch replay, Export and the check", async () => {
    strip("complete", "opens, 4 sheets");
    expect(await screen.findByRole("button", { name: "Watch replay (1:42)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watch from the key change" })).toBeTruthy();
    expect(screen.getByText("Checked: opens, 4 sheets")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export proof video" })).toBeTruthy();
  });
  it("hides Export proof video without a recording, and the check when there is none", async () => {
    strip("none", null);
    await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(screen.queryByRole("button", { name: "Export proof video" })).toBeNull();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
  });
  it("holds no room for frames before the answer, so a result without any never jumps", async () => {
    let answer = () => {};
    const { container } = strip(
      "complete",
      null,
      [],
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => {});
    expect(container.querySelector(".proof-frames")).toBeNull();
    answer();
    await screen.findByRole("button", { name: "Watch replay (1:42)" });
    expect(container.querySelector(".proof-frames")).toBeNull();
  });
  it("offers Export proof video for a turn without screenshots, since the recording covers it", async () => {
    strip("complete", null, []);
    expect(await screen.findByRole("button", { name: "Export proof video" })).toBeTruthy();
  });
  it("opens Replay at the frame's moment, and Export at this result's part of the recording", async () => {
    strip("complete", null);
    fireEvent.click(await screen.findByRole("button", { name: "Watch from the key change" }));
    let params = new URLSearchParams(window.location.search);
    expect([params.get("replay"), params.get("t")]).toEqual([ID, "40000"]);
    fireEvent.click(screen.getByRole("button", { name: "Export proof video" }));
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
