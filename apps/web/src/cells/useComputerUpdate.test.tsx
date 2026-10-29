// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { CellSummary } from "./types.ts";

type Kit = typeof import("../ui/Toast.tsx") & typeof import("./useComputerUpdate.ts");
let kit: Kit;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetModules();
  localStorage.clear();
  kit = { ...(await import("../ui/Toast.tsx")), ...(await import("./useComputerUpdate.ts")) };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const cell = (patch: Partial<CellSummary> = {}): CellSummary => ({
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "2026-10-09",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 7 },
  ...patch,
});

function control() {
  const calls: { url: string; method: string | undefined }[] = [];
  let answer: (response: Response) => void = () => {};
  const api = createApi("t", {
    origin: "http://fixture",
    fetchImpl: (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    },
  });
  return { api, calls, answer: (response: Response) => answer(response) };
}

function Shell({
  api,
  computer,
  idle = true,
}: {
  api: ReturnType<typeof createApi>;
  computer: CellSummary;
  idle?: boolean;
}) {
  const island = useRef<HTMLDivElement>(null);
  const update = kit.useComputerUpdate(api, computer);
  kit.useUpdateNotice(computer, idle, update);
  return (
    <div>
      <div ref={island}>Island</div>
      <button type="button" onClick={update.run}>
        {update.busy ? "Updating your computer…" : "Update"}
      </button>
      <p data-testid="error">{update.error ?? ""}</p>
      <kit.Toaster anchor={island} />
    </div>
  );
}
const settle = async (ms = 500) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};
const toasts = () => screen.queryAllByRole("listitem").map((item) => item.textContent);

it("passes on only the daemon's own plain refusals", () => {
  const missing =
    "The previous system image is missing from Docker. Restore it before updating this computer. Your apps and files are unchanged.";
  expect(kit.describeUpdateError(409, missing)).toBe(missing);
  expect(kit.describeUpdateError(409, "Hand back the computer first.")).toBe(
    "Hand back the computer first.",
  );
  expect(kit.describeUpdateError(409, "unknown cell 01J at /Users/me/.localdot")).toBe(
    "Your computer couldn't be updated. Try again.",
  );
  expect(kit.describeUpdateError(502, "docker 500 on /containers/x")).toContain("Docker");
  expect(kit.describeUpdateError(null, "")).toBe(
    "localDot isn't answering. Check that it's running.",
  );
  expect(
    kit.describeUpdateError(409, "Your computer couldn't be updated. Turn it on to keep using it."),
  ).toBe("Your computer couldn't be updated. Turn it on to keep using it.");
});

it("sends one update at a time and stays busy until the daemon answers", async () => {
  const { api, calls, answer } = control();
  render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  fireEvent.click(screen.getByRole("button", { name: "Updating your computer…" }));
  expect(calls).toEqual([
    { url: "http://fixture/api/cells/01JXYZ0000000000000000ABCD/update", method: "POST" },
  ]);
  await act(async () => answer(new Response(null, { status: 202 })));
  expect(screen.getByRole("button").textContent).toBe("Update");
});

it("shows a refusal in place and from the island", async () => {
  const { api, answer } = control();
  render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await act(async () =>
    answer(new Response("Wait for dot to finish, or stop the task first.", { status: 409 })),
  );
  expect(screen.getByTestId("error").textContent).toBe(
    "Wait for dot to finish, or stop the task first.",
  );
  await settle();
  expect(toasts()[0]).toContain("Wait for dot to finish");
});

it("says once that a new version is ready, only while dot is not at work", async () => {
  const { api } = control();
  const view = render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  await settle();
  expect(toasts()).toEqual([]);
  view.rerender(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  expect(toasts()[0]).toContain(kit.UPDATE_READY);
  view.unmount();

  // Another visit keeps quiet about the same version.
  vi.resetModules();
  kit = { ...(await import("../ui/Toast.tsx")), ...(await import("./useComputerUpdate.ts")) };
  render(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  expect(toasts().join()).not.toContain(kit.UPDATE_READY);
});

it("takes the notice back when dot starts working", async () => {
  const { api } = control();
  const view = render(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  expect(toasts()[0]).toContain(kit.UPDATE_READY);
  view.rerender(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  await settle(10_000);
  expect(toasts().join()).not.toContain(kit.UPDATE_READY);
  // Once said, it stays said: Settings keeps the Update row.
  view.rerender(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle(10_000);
  expect(toasts().join()).not.toContain(kit.UPDATE_READY);
});

it("can say so again once the computer was brought up to date", async () => {
  const { api } = control();
  const view = render(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  view.rerender(<Shell api={api} computer={cell()} />);
  await settle(10_000);
  view.rerender(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  expect(toasts()[0]).toContain(kit.UPDATE_READY);
});

it("updates from the notice", async () => {
  const { api, calls } = control();
  render(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  fireEvent.click(within(screen.getByRole("listitem")).getByRole("button", { name: "Update" }));
  expect(calls).toHaveLength(1);
});

it("says once that an update can't be applied, without offering it", async () => {
  const { api } = control();
  expect(kit.describeUpdateError(409, kit.UPDATE_BLOCKED)).toBe(kit.UPDATE_BLOCKED);
  const view = render(<Shell api={api} computer={cell({ updateBlocked: true })} />);
  await settle();
  expect(toasts()).toEqual([kit.UPDATE_BLOCKED]);
  expect(within(screen.getByRole("listitem")).queryByRole("button", { name: "Update" })).toBeNull();
  view.unmount();

  vi.resetModules();
  kit = { ...(await import("../ui/Toast.tsx")), ...(await import("./useComputerUpdate.ts")) };
  const again = render(<Shell api={api} computer={cell({ updateBlocked: true })} />);
  await settle(10_000);
  expect(toasts()).toEqual([]);
  // A different new version is offered as usual.
  again.rerender(<Shell api={api} computer={cell({ updateAvailable: true })} />);
  await settle();
  expect(toasts()[0]).toContain(kit.UPDATE_READY);
});

it("tells a refused update once, when the computer says it is blocked", async () => {
  const { api, answer } = control();
  const view = render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  view.rerender(<Shell api={api} computer={cell({ updateBlocked: true })} idle={false} />);
  await act(async () => answer(new Response(kit.UPDATE_BLOCKED, { status: 409 })));
  expect(screen.getByTestId("error").textContent).toBe(kit.UPDATE_BLOCKED);
  view.rerender(<Shell api={api} computer={cell({ updateBlocked: true })} />);
  await settle();
  expect(toasts()).toEqual([kit.UPDATE_BLOCKED]);
  expect(screen.getByRole("listitem").dataset.tone).toBe("neutral");
  await settle(10_000);
  expect(toasts()).toEqual([]);
});

it("keeps a confirmed update busy when a remote proxy times out", async () => {
  const { api, answer } = control();
  const view = render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  view.rerender(
    <Shell api={api} computer={cell({ updateAvailable: true, updating: true })} idle={false} />,
  );
  await act(async () => answer(new Response(null, { status: 504 })));
  expect(screen.getByTestId("error").textContent).toBe("");
  expect(screen.getByRole("button").textContent).toBe("Updating your computer…");
  await settle();
  expect(toasts().join()).toContain("still updating");
});
