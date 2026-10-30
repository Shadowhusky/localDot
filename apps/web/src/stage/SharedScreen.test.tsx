// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { SharedScreen } from "./SharedScreen.tsx";

afterEach(cleanup);
const SESSION = "01JXYZ0000000000000000SESS";
const FRAME = "01JXYZ000000000000000FRAME";

it("shows the task's own last look while another task has the screen, and nothing otherwise", async () => {
  const asked: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    asked.push(new URL(String(input)).pathname);
    return new Response(new Blob(["webp"], { type: "image/webp" }));
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:frame", revokeObjectURL: () => {} }),
  );
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const view = render(
    <SharedScreen api={api} sessionId={SESSION} frameId={FRAME} elsewhere={false} />,
  );
  expect(view.container.innerHTML).toBe("");
  view.rerender(<SharedScreen api={api} sessionId={SESSION} frameId={FRAME} elsewhere />);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Another task"));
  expect(asked).toEqual([`/api/sessions/${SESSION}/frames/${FRAME}`]);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:frame");
  view.rerender(<SharedScreen api={api} sessionId={SESSION} frameId={FRAME} elsewhere={false} />);
  expect(view.container.innerHTML).toBe("");
  vi.unstubAllGlobals();
});
