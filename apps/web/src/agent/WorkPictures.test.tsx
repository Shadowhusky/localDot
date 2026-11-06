// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { StepRowView } from "../session/session-view.ts";
import { disposition } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { StepPreviewScope } from "./StepPreview.tsx";
import type { WorkStep } from "./thread.ts";
import { WorkPictures, workPictures } from "./WorkPictures.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SESSION = "01J00000000000000000000001";
const step = (
  key: string,
  { frameId, images }: { frameId?: string; images?: AgentStep["images"] } = {},
): WorkStep => ({
  key,
  entry: {
    key,
    row: {
      kind: "step",
      id: key,
      startT: 0,
      ...(frameId
        ? {
            computer: {
              id: key,
              label: key,
              startT: 0,
              status: "ok",
              durationMs: 1,
              frameId,
            } satisfies StepRowView,
          }
        : {}),
      ...(images ? { agent: { id: key, output: [], outputTruncated: false, images } } : {}),
    },
    keys: [],
  },
  changes: [],
  testId: "step-row",
  title: `Step ${key}`,
  meta: "",
  time: "",
  state: "done",
  stateLabel: "Done",
  startT: 0,
  endT: 1,
});
const image = (name: string, alt = "") => ({ name: `step-image-${name}.jpg`, alt });

it("shows the pictures a run's tools brought back, then the screen as its last step left it", () => {
  const pictures = workPictures([
    step("click", { frameId: "01J00000000000000000000F01" }),
    step("search", { images: [image("a", "A poster"), image("b")] }),
    step("type", { frameId: "01J00000000000000000000F02" }),
    step("think"),
  ]);
  expect(pictures.map((picture) => picture.label)).toEqual([
    "Preview image: A poster",
    "Preview image: Step search",
    "Preview screenshot: Step type",
  ]);
  expect(workPictures([step("think")])).toEqual([]);
});

const API = () =>
  createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async () => new Response("gone", { status: 404 }),
  });

it("opens a picture large where it is, moving between the run's pictures", () => {
  render(
    <StepPreviewScope api={API()} sessionId={SESSION} results={[]}>
      <WorkPictures
        steps={[
          step("search", { images: [image("a", "A poster"), image("b", "B poster")] }),
          step("type", { frameId: "01J00000000000000000000F02" }),
        ]}
      />
    </StepPreviewScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview image: A poster" }));
  const viewer = screen.getByRole("dialog", { name: "A poster" });
  expect(within(viewer).getByText("1 of 3")).toBeTruthy();
  fireEvent.click(within(viewer).getByRole("button", { name: "Next picture" }));
  expect(screen.getByRole("dialog", { name: "B poster" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  // The screenshot the run left, in the same viewer, has no file to download.
  const shot = screen.getByRole("dialog", { name: "Step screenshot" });
  expect(within(shot).getByText("3 of 3")).toBeTruthy();
  expect(within(shot).queryByRole("button", { name: "Download" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(within(shot).getByText("3 of 3")).toBeTruthy();
});

it("opens the pictures past the first few in place, without touching the run's steps", () => {
  const onToggle = vi.fn();
  render(
    <StepPreviewScope api={API()} sessionId={SESSION} results={[]}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stands for a steps container that folds on a press. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only the press is under test. */}
      <div onClick={onToggle}>
        <WorkPictures
          steps={[
            step("search", { images: [image("a"), image("b"), image("c")] }),
            step("type", { frameId: "01J00000000000000000000F02" }),
          ]}
        />
      </div>
    </StepPreviewScope>,
  );
  const list = screen.getByRole("list", { name: "Pictures" });
  const buttons = () => [...list.querySelectorAll("button")];
  expect(buttons().map((button) => button.ariaLabel)).toEqual([
    "Preview image: Step search",
    "Preview image: Step search",
    "Show 2 more pictures",
  ]);
  expect(list.hasAttribute("data-strip")).toBe(false);
  onToggle.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more pictures" }));
  expect(list.hasAttribute("data-strip")).toBe(true);
  expect(buttons().map((button) => button.ariaLabel)).toEqual([
    "Preview image: Step search",
    "Preview image: Step search",
    "Preview image: Step search",
    "Preview screenshot: Step type",
  ]);
  expect(document.activeElement).toBe(buttons()[2]);
  // Pressing a picture in the row opens it among all four.
  fireEvent.click(buttons()[3] as HTMLButtonElement);
  expect(screen.getByRole("dialog", { name: "Step screenshot" }).textContent).toContain("4 of 4");
});

it("shows nothing where there is no task to read pictures from", () => {
  const view = render(
    <WorkPictures steps={[step("type", { frameId: "01J00000000000000000000F02" })]} />,
  );
  expect(view.container.childElementCount).toBe(0);
});

const saved = (name: string) =>
  new Response(new Uint8Array([255, 216, 255]), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": disposition(`step-image-${name}.jpg`),
      "x-content-type-options": "nosniff",
    },
  });

// A view where everything is near, once it is watched.
function watchEverything() {
  const watched: Element[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        watched.push(element);
        queueMicrotask(() =>
          this.callback(
            [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      disconnect() {}
    },
  );
  return watched;
}

it("loads a run's first picture when it comes after the run was drawn", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:picture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const watched = watchEverything();
  const fetchImpl = vi.fn(async () => saved("late"));
  const api = createApi("fixture", { origin: "http://127.0.0.1:4790", fetchImpl });
  const scope = (steps: WorkStep[]) => (
    <StepPreviewScope api={api} sessionId={SESSION} results={[]}>
      <WorkPictures steps={steps} />
    </StepPreviewScope>
  );
  const view = render(scope([step("think")]));
  expect(screen.queryByRole("list", { name: "Pictures" })).toBeNull();
  view.rerender(scope([step("think"), step("search", { images: [image("late")] })]));
  expect(watched).toHaveLength(1);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:picture");
  vi.unstubAllGlobals();
});

it("loads a picture again after it failed, keeping its place meanwhile", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:picture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  watchEverything();
  let down = true;
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async () => (down ? new Response("no", { status: 503 }) : saved("flaky")),
  });
  const view = render(
    <StepPreviewScope api={api} sessionId={SESSION} results={[]}>
      <WorkPictures steps={[step("search", { images: [image("flaky")] })]} />
    </StepPreviewScope>,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector(".thread-picture .replay-image-empty")).not.toBeNull();
  down = false;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:picture");
  vi.unstubAllGlobals();
});
