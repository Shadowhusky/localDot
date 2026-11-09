// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

it("keeps a confirmed update busy when a remote proxy times out, and says nothing false", async () => {
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
  expect(toasts().join()).not.toMatch(/couldn't|isn't answering/);
});

describe("what an update says", () => {
  function Watch({
    api,
    computer,
    details = () => {},
  }: {
    api: ReturnType<typeof createApi>;
    computer: CellSummary;
    details?: () => void;
  }) {
    const island = useRef<HTMLDivElement>(null);
    const update = kit.useComputerUpdate(api, computer);
    kit.useUpdateProgressNotice(computer, update, details);
    return (
      <div>
        <div ref={island}>Island</div>
        <p data-testid="stage">{update.stage ?? "none"}</p>
        <p data-testid="line">{update.line ?? ""}</p>
        <p data-testid="value">{String(update.value ?? "")}</p>
        <p data-testid="note">{update.note ?? ""}</p>
        <button type="button" onClick={update.run}>
          {update.busy ? "Updating" : "Update"}
        </button>
        <kit.Toaster anchor={island} />
      </div>
    );
  }
  const updating = (progress?: CellSummary["updateProgress"], more: Partial<CellSummary> = {}) =>
    cell({ state: "stopping", updating: true, updateProgress: progress, ...more });

  it("shows a stage the moment Update is pressed, before the daemon has said anything", () => {
    const { api } = control();
    render(<Watch api={api} computer={cell({ updateAvailable: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByTestId("stage").textContent).toBe("download");
    expect(screen.getByTestId("line").textContent).toBe("Step 1 of 6 · Getting the new version");
  });

  it("follows the daemon's stages with percent and bytes on a bar that doesn't run ahead", () => {
    const { api } = control();
    const view = render(
      <Watch
        api={api}
        computer={cell({
          updating: true,
          updateProgress: {
            stage: "download",
            share: 0.45,
            detail: "Downloading · 45% · 1.4 of 3.1 GB",
          },
        })}
      />,
    );
    expect(screen.getByTestId("line").textContent).toBe(
      "Step 1 of 6 · Downloading · 45% · 1.4 of 3.1 GB",
    );
    expect(Number(screen.getByTestId("value").textContent)).toBeCloseTo(0.075);
    view.rerender(<Watch api={api} computer={updating({ stage: "keep" })} />);
    expect(screen.getByTestId("line").textContent).toBe(
      "Step 3 of 6 · Keeping your apps and files",
    );
    expect(Number(screen.getByTestId("value").textContent)).toBeCloseTo(2 / 6);
  });

  it("follows on any device, wherever it is looking, with a way to the details", async () => {
    const { api } = control();
    const details = vi.fn();
    render(<Watch api={api} computer={updating({ stage: "replace" })} details={details} />);
    await settle();
    expect(toasts().join()).toContain("Updating your computer · Step 4 of 6 · Installing");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(details).toHaveBeenCalled();
  });

  it("says plainly when it runs long, from the daemon's clock", () => {
    const { api } = control();
    const operation = (elapsedMs: number) =>
      ({
        kind: "update",
        step: "install",
        startedAt: elapsedMs,
        elapsedMs,
        expectedMs: 40_000,
      }) as const;
    const view = render(
      <Watch api={api} computer={updating({ stage: "keep" }, { operation: operation(60_000) })} />,
    );
    expect(screen.getByTestId("note").textContent).toBe("");
    view.rerender(
      <Watch api={api} computer={updating({ stage: "keep" }, { operation: operation(240_000) })} />,
    );
    expect(screen.getByTestId("note").textContent).toContain("taking longer than usual");
    view.rerender(
      <Watch
        api={api}
        computer={updating({ stage: "keep" }, { operation: operation(31 * 60_000) })}
      />,
    );
    expect(screen.getByTestId("note").textContent).toContain("Your files are kept");
  });

  const failure = {
    stage: "replace",
    message: "Your computer couldn't be updated. It's back as it was, and your files are kept.",
    at: 1234,
  } as const;

  it("tells every device an update failed, once, with Retry when it can be tried again", async () => {
    const { api, calls } = control();
    const view = render(
      <Watch api={api} computer={cell({ updateAvailable: true, updateFailure: failure })} />,
    );
    await settle();
    expect(toasts().join()).toContain("Your computer wasn't updated");
    expect(toasts().join()).toContain("It's back as it was");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls.length).toBe(1);
    view.unmount();
    await settle(7000);
    render(<Watch api={api} computer={cell({ updateAvailable: true, updateFailure: failure })} />);
    await settle();
    expect(toasts().join()).not.toContain("Your computer wasn't updated");
  });

  it("says so again when the same failure's words change", async () => {
    const { api } = control();
    const away = {
      ...failure,
      at: 77,
      message:
        "Your computer couldn't be updated. Your files are kept. It starts again by itself as soon as Docker answers.",
    };
    const view = render(
      <Watch api={api} computer={cell({ state: "failed", updateFailure: away })} />,
    );
    await settle();
    expect(toasts().join()).toContain("as soon as Docker answers");
    view.rerender(
      <Watch
        api={api}
        computer={cell({ updateAvailable: true, updateFailure: { ...failure, at: 77 } })}
      />,
    );
    await settle(2000);
    expect(toasts().join()).toContain("It's back as it was");
    expect(toasts().join()).not.toContain("as soon as Docker answers");
  });

  it("offers no Retry when there is nothing left to try again", async () => {
    const { api } = control();
    render(
      <Watch
        api={api}
        computer={cell({ state: "failed", updateFailure: { ...failure, stage: "start", at: 99 } })}
      />,
    );
    await settle();
    expect(toasts().join()).toContain("Your computer wasn't updated");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says it worked once the computer is back, and that the files are there", async () => {
    const { api } = control();
    const view = render(<Watch api={api} computer={updating({ stage: "start" })} />);
    await settle();
    view.rerender(<Watch api={api} computer={cell({ state: "ready" })} />);
    await settle(2000);
    expect(toasts().join()).toContain("Your computer is updated");
    expect(toasts().join()).toContain("Your files and sign-ins are all still there.");
  });

  it("doesn't call a refused press an update", async () => {
    const { api, answer } = control();
    render(<Watch api={api} computer={cell({ updateAvailable: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () =>
      answer(new Response("Wait for dot to finish, or stop the task first.", { status: 409 })),
    );
    await settle(2000);
    expect(toasts().join()).not.toContain("Your computer is updated");
  });

  it("says nothing of an update this page never saw", async () => {
    const { api } = control();
    render(<Watch api={api} computer={cell({ state: "ready" })} />);
    await settle();
    expect(toasts()).toEqual([]);
  });

  it("leaves a failure the summary reports to the summary, rather than saying it twice", async () => {
    const { api, answer } = control();
    render(<Shell api={api} computer={cell({ updateAvailable: true })} idle={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await act(async () =>
      answer(
        new Response("Your computer couldn't be updated. It's back as it was.", { status: 409 }),
      ),
    );
    await settle();
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(toasts()).toEqual([]);
  });
});
