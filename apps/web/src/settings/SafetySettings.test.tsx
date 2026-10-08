// @vitest-environment jsdom
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SafetySettings } from "./SafetySettings.tsx";

afterEach(cleanup);

it("says uploads need the user, since they ask or hand off with sending", () => {
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} />);
  const note = screen.getByText(/always handed to you/);
  expect(note.textContent).toContain("Uploads always need you.");
  expect(note.textContent).not.toMatch(/uploads[^.]*always ask/i);
  expect(note.textContent).toContain("commands once you sign in on its computer");
});
