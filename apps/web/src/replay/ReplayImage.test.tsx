// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ReplayImage } from "./ReplayImage.tsx";

const sessionId = "01K00000000000000000000000";

beforeEach(() => {
  let next = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => `blob:${++next}`, revokeObjectURL() {} }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function daemon() {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input)).pathname.split("/").slice(-2).join("/"));
    return new Response(new Blob(["webp"]));
  }) as typeof fetch;
  return { api: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" }), asked };
}

async function show(api: ReturnType<typeof createApi>, frames: string[], full: boolean) {
  const { container, rerender } = render(
    <ReplayImage api={api} sessionId={sessionId} frameId={frames[0] ?? null} full={full} />,
  );
  for (const frameId of frames) {
    rerender(<ReplayImage api={api} sessionId={sessionId} frameId={frameId} full={full} />);
    const shown = container.querySelector("img")?.src;
    await waitFor(() => expect(container.querySelector("img")?.src).not.toBe(shown));
  }
}

const frames = Array.from({ length: 9 }, (_, at) => `frame${at}`);

it("keeps only the last few full frames, which are large", async () => {
  const { api, asked } = daemon();
  await show(api, [...frames, "frame0"], true);
  expect(asked.filter((path) => path === "frames/frame0")).toHaveLength(2);
  await show(api, ["frame8", "frame2"], true);
  expect(asked.filter((path) => path === "frames/frame2")).toHaveLength(1);
});

it("keeps many more thumbnails than full frames", async () => {
  const { api, asked } = daemon();
  await show(api, [...frames, "frame0"], false);
  expect(asked.filter((path) => path === "thumbs/frame0")).toHaveLength(1);
});
