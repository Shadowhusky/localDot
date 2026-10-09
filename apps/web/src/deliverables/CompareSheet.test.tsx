// @vitest-environment jsdom
import type { FileVersion } from "@localdot/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { CompareSheet, changesOnly } from "./CompareSheet.tsx";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const v = (n: number): FileVersion => ({
  sessionId: ID,
  version: n,
  label: n,
  bytes: 1,
  resultId: ID,
  tMs: 0,
  available: true,
});
afterEach(cleanup);
const sheet = (reply: () => Response) => {
  const calls: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return reply();
    },
  });
  render(
    <CompareSheet
      api={api}
      sessionId={ID}
      name="totals.csv"
      from={v(1)}
      to={v(2)}
      open
      onClose={vi.fn()}
    />,
  );
  return calls;
};
describe("compare sheet", () => {
  it("shows the changes without the patch's own file lines", () => {
    expect(changesOnly("--- a/t.csv\n+++ b/t.csv\n@@ -1 +1,2 @@\n a\n+b\n")).toBe(
      "@@ -1 +1,2 @@\n a\n+b",
    );
  });
  it("asks for the diff between the two versions and shows it", async () => {
    const calls = sheet(() =>
      Response.json({
        from: 1,
        to: 2,
        patch: "--- a/totals.csv\n+++ b/totals.csv\n@@ -1 +1,2 @@\n Dec,12000\n+Total,23800\n",
        truncated: false,
      }),
    );
    expect(await screen.findByRole("dialog", { name: "Compare totals.csv" })).toBeTruthy();
    expect(await screen.findByText(/Total,23800/)).toBeTruthy();
    expect(calls[0]).toContain(`/files/totals.csv/compare?from=${ID}.1&to=${ID}.2`);
  });
  it("says when two versions are the same, and when the diff could not be made", async () => {
    sheet(() => Response.json({ from: 1, to: 2, patch: "", truncated: false }));
    expect(await screen.findByText("No changes between v1 and v2.")).toBeTruthy();
    cleanup();
    sheet(() => new Response("these versions are too large or not text", { status: 422 }));
    expect(await screen.findByText("Couldn't compare these versions.")).toBeTruthy();
  });
});
