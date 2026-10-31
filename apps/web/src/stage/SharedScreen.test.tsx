// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type ApiClient, createApi } from "../lib/api.ts";
import { SharedScreen, useSharedLook } from "./SharedScreen.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const SESSION = "01JXYZ0000000000000000SESS";
const FRAME = "01JXYZ000000000000000FRAME";

function Shared({ api, elsewhere }: { api: ApiClient; elsewhere: boolean }) {
  const look = useSharedLook(api, SESSION, FRAME, elsewhere);
  return (
    <div data-waiting={look.waiting}>
      <SharedScreen look={look} />
    </div>
  );
}

const fixtureApi = (reply: () => Response) => {
  const asked: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    asked.push(new URL(String(input)).pathname);
    return reply();
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:frame", revokeObjectURL: () => {} }),
  );
  return { asked, api: createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl }) };
};

it("shows the task's own last look while another task has the screen, and nothing otherwise", async () => {
  const { asked, api } = fixtureApi(() => new Response(new Blob(["webp"], { type: "image/webp" })));
  const view = render(<Shared api={api} elsewhere={false} />);
  const box = () => view.container.firstElementChild as HTMLElement;
  expect(box().innerHTML).toBe("");
  expect(box().dataset.waiting).toBe("false");
  view.rerender(<Shared api={api} elsewhere />);
  // Until the look is in, whoever waits for it knows.
  expect(box().dataset.waiting).toBe("true");
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Another task"));
  expect(box().dataset.waiting).toBe("false");
  expect(asked).toEqual([`/api/sessions/${SESSION}/frames/${FRAME}`]);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:frame");
  view.rerender(<Shared api={api} elsewhere={false} />);
  expect(box().innerHTML).toBe("");
});

it("stops waiting for a look that can't be read, and leaves the live picture", async () => {
  const { api } = fixtureApi(() => new Response("gone", { status: 404 }));
  const view = render(<Shared api={api} elsewhere />);
  const box = () => view.container.firstElementChild as HTMLElement;
  expect(box().dataset.waiting).toBe("true");
  await waitFor(() => expect(box().dataset.waiting).toBe("false"));
  expect(box().innerHTML).toBe("");
});
