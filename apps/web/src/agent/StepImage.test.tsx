// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { disposition } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { StepImage } from "./StepImage.tsx";
import { StepPreviewScope } from "./StepPreview.tsx";
import { TerminalViewer } from "./TerminalViewer.tsx";
import { appendTerminal, emptyTerminal, finishTerminal } from "./terminal-text.ts";

const sessionId = "00000000000000000000000001";
const image = {
  name: "step-image-00000000000000000000000002.jpg",
  alt: "~/flower-poster/assets/hero1.jpg",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("loads a saved image using authentication and releases it when the step closes", async () => {
  const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:step-image");
  const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const fetchImpl = vi.fn(
    async () =>
      new Response(new Uint8Array([255, 216, 255]), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": disposition(image.name),
          "x-content-type-options": "nosniff",
        },
      }),
  );
  const api = createApi("test-token", { fetchImpl, origin: "https://localdot.test" });
  const view = render(<StepImage api={api} sessionId={sessionId} image={image} />);
  expect((await screen.findByRole("img", { name: image.alt })).getAttribute("src")).toBe(
    "blob:step-image",
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    `https://localdot.test/api/agent/sessions/${sessionId}/files/${image.name}`,
    expect.objectContaining({ headers: { authorization: "Bearer test-token" }, redirect: "error" }),
  );
  expect(created.mock.calls[0]?.[0]).toHaveProperty("type", "image/jpeg");
  view.unmount();
  expect(revoked).toHaveBeenCalledWith("blob:step-image");
});
it("shows an explicit unavailable state for missing historical images", async () => {
  const api = createApi("test-token", {
    fetchImpl: vi.fn(async () => new Response("not found", { status: 404 })),
    origin: "https://localdot.test",
  });
  render(<StepImage api={api} sessionId={sessionId} image={image} />);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Image preview unavailable."),
  );
  expect(screen.queryByRole("img")).toBeNull();
});
const saved = () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:step-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return createApi("test-token", {
    origin: "http://127.0.0.1:4750",
    fetchImpl: vi.fn(async (url) =>
      String(url).endsWith("/preview-link")
        ? Response.json({ base: `/file-previews/${"t".repeat(43)}/` })
        : new Response(new Uint8Array([255, 216, 255]), {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": disposition(image.name),
              "x-content-type-options": "nosniff",
            },
          }),
    ),
  });
};
it("opens the real picture from a press anywhere on it, named by what it was read from", async () => {
  render(
    <StepPreviewScope api={saved()} sessionId={sessionId} results={[]}>
      <StepImage api={saved()} sessionId={sessionId} image={image} />
    </StepPreviewScope>,
  );
  await screen.findByRole("img", { name: image.alt });
  fireEvent.click(screen.getByRole("button", { name: "Preview image" }));
  const dialog = await screen.findByRole("dialog", { name: image.alt });
  await waitFor(() =>
    expect(dialog.querySelector("img")?.src).toContain(`/file-previews/${"t".repeat(43)}/`),
  );
  expect(dialog.querySelector("img")?.src).toContain(image.name);
});
it("doesn't offer a read picture's caption as the thing to preview", () => {
  const terminal = finishTerminal(
    appendTerminal(emptyTerminal(), "stdout", `${image.alt} · 858722 bytes`),
  );
  const step = (images?: AgentStep["images"]): AgentStep => ({
    id: "s",
    output: [],
    outputTruncated: false,
    terminal,
    ...(images ? { images } : {}),
  });
  const view = render(
    <StepPreviewScope api={saved()} sessionId={sessionId} results={[]}>
      <TerminalViewer step={step()} />
    </StepPreviewScope>,
  );
  expect(screen.queryByRole("button", { name: "Preview output" })).toBeTruthy();
  view.rerender(
    <StepPreviewScope api={saved()} sessionId={sessionId} results={[]}>
      <TerminalViewer step={step([image])} />
    </StepPreviewScope>,
  );
  expect(screen.queryByRole("button", { name: "Preview output" })).toBeNull();
});
