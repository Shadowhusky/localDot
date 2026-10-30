// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import { RecordingStorageSettings } from "./RecordingStorage.tsx";

afterEach(cleanup);

it("shows what the videos and screenshots take, what re-encoding saved, and when they go", async () => {
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: (async (input) => {
      expect(new URL(String(input)).pathname).toBe("/api/recordings/storage");
      return Response.json({
        videos: 12,
        bytes: 3 * 1024 ** 3,
        savedBytes: 17 * 1024 ** 3,
        maxBytes: 20 * 1024 ** 3,
        maxAgeDays: 30,
        framesBytes: 2 * 1024 ** 3,
        framesMaxAgeDays: 180,
      });
    }) as typeof fetch,
  });
  render(<RecordingStorageSettings api={api} />);
  expect(await screen.findByText("3.0 GB")).toBeTruthy();
  expect(screen.getByText("12 videos · 17.0 GB saved by re-encoding")).toBeTruthy();
  expect(screen.getByText("2.0 GB")).toBeTruthy();
  expect(
    screen.getByText(/kept for 30 days and up to 20.0 GB in all, oldest removed first/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Screenshots stay for 180 days, then only each task's cover/),
  ).toBeTruthy();
});
