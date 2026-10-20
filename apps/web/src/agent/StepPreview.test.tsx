// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ViewerEntry } from "../deliverables/viewer/scope.tsx";
import { createApi } from "../lib/api.ts";
import {
  referencedFiles,
  StepFileResources,
  StepPreviewButton,
  StepPreviewScope,
} from "./StepPreview.tsx";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const file = (name: string, version = 1): ViewerEntry => ({
  resultId: "result",
  sessionId: ID,
  file: { name, path: `Documents/${name}`, bytes: 100, version },
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("matches recorded files without inventing resources from remote URLs or arbitrary paths", () => {
  const video = file("movie.mp4");
  expect(referencedFiles('Saved "Documents/movie.mp4"', [video])).toEqual([video]);
  expect(referencedFiles("Read `movie.mp4`", [video])).toEqual([video]);
  for (const text of [
    "https://evil.test/movie.mp4",
    "/other/movie.mp4",
    "movie.mp4.exe",
    "notmovie.mp4",
    "~/unrecorded.png",
  ]) {
    expect(referencedFiles(text, [video])).toEqual([]);
  }
  expect(
    referencedFiles("movie.mp4", [video, file("movie.mp4", 2)]).map((e) => e.file.version),
  ).toEqual([2]);
});

it("opens recorded code without any network request and keeps the preview when its row unmounts", async () => {
  const fetchImpl = vi.fn();
  const api = createApi("token", { fetchImpl });
  const source = "<script>doNotExecute()</script>\nconst answer = 42;";
  const renderScope = (row: boolean) => (
    <StepPreviewScope api={api} sessionId={ID} results={[]}>
      {row && (
        <StepPreviewButton
          label="Preview code"
          resource={{ kind: "text", name: "main.ts", text: source }}
        />
      )}
    </StepPreviewScope>
  );
  const view = render(renderScope(true));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview code" }));
  const dialog = await screen.findByRole("dialog", { name: "main.ts" });
  expect(dialog.textContent).toContain(source.split("\n")[0]);
  expect(dialog.querySelector("script")).toBeNull();
  view.rerender(renderScope(false));
  expect(screen.getByRole("dialog", { name: "main.ts" })).toBeTruthy();
  expect(fetchImpl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("opens a saved video on demand using its session and version in the existing media viewer", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ base: `/file-previews/${"t".repeat(43)}/` }));
  const api = createApi("token", { fetchImpl, origin: "http://127.0.0.1:4750" });
  const video = file("movie.mp4", 3);
  render(
    <StepPreviewScope
      api={api}
      sessionId={ID}
      results={[{ id: video.resultId, summary: "", files: [video.file] }]}
    >
      <StepFileResources text="Saved Documents/movie.mp4" />
    </StepPreviewScope>,
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview movie.mp4" }));
  await waitFor(() => expect(document.querySelector("video")?.src).toContain("movie.mp4?v=3"));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(document.querySelector("video")?.autoplay).toBe(false);
});

it("dismisses the old session preview without remounting the composer", async () => {
  const api = createApi("token", { fetchImpl: vi.fn() });
  const scope = (id: string | null) => (
    <StepPreviewScope api={api} sessionId={id} results={[]}>
      <input aria-label="Message" defaultValue="Unsent draft" />
      <StepPreviewButton
        label="Preview output"
        resource={{ kind: "text", name: "Output", text: "old session" }}
      />
    </StepPreviewScope>
  );
  const view = render(scope(null));
  const input = screen.getByRole("textbox");
  input.focus();
  view.rerender(scope(ID));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: "Preview output" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  view.rerender(scope("01J9ZQ3V8Y7X6W5T4S3R2Q1P0P"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("textbox")).toBe(input);
});
