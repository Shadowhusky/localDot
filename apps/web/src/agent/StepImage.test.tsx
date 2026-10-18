// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { disposition } from "./file-transfer.ts";
import { StepImage } from "./StepImage.tsx";

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
