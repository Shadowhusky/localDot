// @vitest-environment jsdom
import type { SessionCard } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type ContinueTask, TaskList, TasksSearch, useTaskIndex } from "./TasksLibrary.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY = 86_400_000;
let next = 0;
function card(title: string, ago: number, verdict: SessionCard["verdict"] = "done"): SessionCard {
  next++;
  return {
    id: `01M4ECBR5X0R92SYA389FM3Q${String(next).padStart(2, "0")}`,
    title,
    startedAt: new Date(Date.now() - ago).toISOString(),
    durationMs: verdict === "live" ? null : 61_000,
    verdict,
    steps: 1,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "none", bytes: 0 },
  };
}

function daemon(pages: SessionCard[][], remove: (id: string) => Response = () => new Response()) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "DELETE") return remove(url.pathname.split("/").at(-1) ?? "");
    asked.push(url.search);
    const at = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : 0;
    return Response.json({
      sessions: pages[at] ?? [],
      next: at + 1 < pages.length ? String(at + 1) : null,
    });
  }) as typeof fetch;
  return { api: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" }), asked };
}

function Library({
  api,
  selected = null,
  onSelect = () => {},
  onDeleted = () => {},
  continueTask,
}: {
  api: ReturnType<typeof createApi>;
  selected?: string | null;
  onSelect?(id: string): void;
  onDeleted?(id: string): void;
  continueTask?: ContinueTask;
}) {
  const index = useTaskIndex(api);
  const [search, setSearch] = useState("");
  return (
    <>
      <TasksSearch value={search} onChange={setSearch} />
      <TaskList
        api={api}
        index={index}
        search={search}
        selectedId={selected}
        onSelect={onSelect}
        onDeleted={onDeleted}
        continueTask={continueTask}
      />
    </>
  );
}

it("groups tasks by day under plain headings, with a verdict on each row", async () => {
  const { api } = daemon([[card("Today's report", 0), card("Yesterday's sort", DAY)]]);
  render(<Library api={api} />);
  const today = await screen.findByRole("region", { name: "Today" });
  expect(within(today).getByRole("link", { name: /^Today's report/ })).toBeTruthy();
  const yesterday = screen.getByRole("region", { name: "Yesterday" });
  const row = within(yesterday).getByRole("link", { name: /^Yesterday's sort/ });
  expect(row.textContent).toContain("1:01");
  expect(within(row).getByRole("img", { name: "Done" })).toBeTruthy();
});

it("opens a task from its row and marks the open one as the current page", async () => {
  const onSelect = vi.fn();
  const first = card("Sort the downloads", 0);
  const { api } = daemon([[first, card("Monthly report", 1000)]]);
  render(<Library api={api} selected={first.id} onSelect={onSelect} />);
  const row = await screen.findByRole("link", { name: /^Monthly report/ });
  expect(
    screen.getByRole("link", { name: /^Sort the downloads/ }).getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith(expect.stringMatching(/^01M4/));
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("searches every word of the title, reading the pages a scroll has not reached", async () => {
  const { api, asked } = daemon([
    [card("Sort the downloads", 0), card("Monthly report", 1000)],
    [card("Email the monthly totals", 2000)],
  ]);
  render(<Library api={api} />);
  await screen.findByRole("link", { name: /^Sort the downloads/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
    target: { value: "MONTHLY" },
  });
  await screen.findByRole("link", { name: /^Email the monthly totals/ });
  expect(asked).toEqual(["", "?before=1"]);
  expect(screen.getByRole("link", { name: /^Monthly report/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /^Sort the downloads/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
    target: { value: "totals email" },
  });
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
    target: { value: "weather" },
  });
  expect(screen.getByText("No tasks match “weather”")).toBeTruthy();
});

it("moves between rows with the arrow keys", async () => {
  const { api } = daemon([[card("First", 0), card("Second", 1000), card("Third", 2000)]]);
  render(<Library api={api} />);
  const first = await screen.findByRole("link", { name: /^First/ });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: /^Second/ }));
  fireEvent.keyDown(document.activeElement as Element, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: /^Third/ }));
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: /^Second/ }));
});

it("deletes a recording only after an anchored confirmation, and says why one cannot go", async () => {
  const onDeleted = vi.fn();
  const running = card("Still running", 0, "live");
  const { api } = daemon([[running, card("Old notes", 1000)]], (id) =>
    id === running.id ? new Response("live", { status: 409 }) : new Response(null, { status: 204 }),
  );
  render(<Library api={api} onDeleted={onDeleted} />);
  const row = await screen.findByRole("link", { name: /^Still running/ });
  row.focus();
  fireEvent.keyDown(row, { key: "Backspace" });
  let confirm = await screen.findByRole("alertdialog", { name: "Delete this task's recording?" });
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
  expect(await within(confirm).findByRole("alert")).toHaveProperty(
    "textContent",
    "This task is still running. Stop it before deleting its recording.",
  );
  expect(onDeleted).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

  fireEvent.click(screen.getByRole("button", { name: "More for Old notes" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Delete recording/ }));
  confirm = await screen.findByRole("alertdialog", { name: "Delete this task's recording?" });
  expect(confirm.textContent).toContain("“Old notes”");
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
  await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
});

it("says when there is nothing recorded yet", async () => {
  const { api } = daemon([[]]);
  render(<Library api={api} />);
  expect(await screen.findByText("No tasks yet")).toBeTruthy();
});

it("asks once for a page a search needs when it fails, then waits for Try again", async () => {
  let failing = true;
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url.search);
    if (url.searchParams.has("before"))
      return failing
        ? new Response("down", { status: 500 })
        : Response.json({ sessions: [card("Email the monthly totals", 2000)], next: null });
    return Response.json({ sessions: [card("Monthly report", 0)], next: "1" });
  }) as typeof fetch;
  render(<Library api={createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" })} />);
  await screen.findByRole("link", { name: /^Monthly report/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
    target: { value: "monthly" },
  });
  const alert = await screen.findByRole("alert");
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(asked).toEqual(["", "?before=1"]);
  failing = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("link", { name: /^Email the monthly totals/ });
  expect(asked).toEqual(["", "?before=1", "?before=1"]);
});

it("keeps the delete confirmation open while the recording is being deleted", async () => {
  let finish = () => {};
  const { api } = daemon([[card("Old notes", 0)]], () => new Response(null, { status: 204 }));
  const slow = {
    ...api,
    del: (path: string) =>
      new Promise<void>((resolve, reject) => {
        finish = () => void api.del(path).then(resolve, reject);
      }),
  };
  const onDeleted = vi.fn();
  render(<Library api={slow} onDeleted={onDeleted} />);
  const row = await screen.findByRole("link", { name: /^Old notes/ });
  row.focus();
  fireEvent.keyDown(row, { key: "Backspace" });
  const confirm = await screen.findByRole("alertdialog", { name: "Delete this task's recording?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  const cancel = within(confirm).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(cancel.getAttribute("aria-disabled")).toBe("true"));
  fireEvent.click(cancel);
  expect(screen.getByRole("alertdialog", { name: "Delete this task's recording?" })).toBe(confirm);
  await act(async () => finish());
  await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
});

it("continues an ended task's conversation from its menu, but not the current or a running one", async () => {
  const run = vi.fn();
  const current = card("Book the hotel", 0);
  const running = card("Still running", 0, "live");
  const older = card("Plan the trip", DAY);
  const { api } = daemon([[current, running, older]]);
  const view = render(<Library api={api} continueTask={{ current: current.id, run }} />);
  for (const title of ["Book the hotel", "Still running"]) {
    fireEvent.click(await screen.findByRole("button", { name: `More for ${title}` }));
    await screen.findByRole("menuitem", { name: /^Delete recording/ });
    expect(screen.queryByRole("menuitem", { name: "Continue conversation" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  }
  fireEvent.click(screen.getByRole("button", { name: "More for Plan the trip" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Continue conversation" }));
  expect(run).toHaveBeenCalledExactlyOnceWith(older.id);

  view.rerender(
    <Library api={api} continueTask={{ current: current.id, run, reason: "Finish first." }} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "More for Plan the trip" }));
  const item = await screen.findByRole("menuitem", { name: "Continue conversation" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item);
  expect(run).toHaveBeenCalledTimes(1);
});
