// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { StepRowView } from "../session/session-view.ts";
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

it("opens a picture large where it is, and points to the steps for the ones past the first few", () => {
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async () => new Response("gone", { status: 404 }),
  });
  const more = vi.fn();
  render(
    <StepPreviewScope api={api} sessionId={SESSION} results={[]}>
      <WorkPictures
        steps={[
          step("search", { images: [image("a"), image("b"), image("c")] }),
          step("type", { frameId: "01J00000000000000000000F02" }),
        ]}
        onMore={more}
      />
    </StepPreviewScope>,
  );
  const list = screen.getByRole("list", { name: "Pictures" });
  expect([...list.querySelectorAll("button")].map((button) => button.ariaLabel)).toEqual([
    "Preview image: Step search",
    "Preview image: Step search",
    "Show 2 more pictures in the steps",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more pictures in the steps" }));
  expect(more).toHaveBeenCalledOnce();
  cleanup();
  render(
    <StepPreviewScope api={api} sessionId={SESSION} results={[]}>
      <WorkPictures
        steps={[step("type", { frameId: "01J00000000000000000000F02" })]}
        onMore={more}
      />
    </StepPreviewScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview screenshot: Step type" }));
  expect(screen.getByRole("dialog", { name: "Step screenshot" })).toBeTruthy();
});

it("shows nothing where there is no task to read pictures from", () => {
  const view = render(
    <WorkPictures
      steps={[step("type", { frameId: "01J00000000000000000000F02" })]}
      onMore={vi.fn()}
    />,
  );
  expect(view.container.childElementCount).toBe(0);
});
