// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Status } from "../session/status.ts";
import { tabTitle, useTabAttention } from "./tab-attention.ts";

const status = (attention: Status["attention"], label = "Needs your answer"): Status => ({
  row: "question",
  computer: "live",
  label,
  caption: { speaker: "dot", text: "" },
  elapsedS: 12,
  actions: [{ kind: "stop-task", enabled: true }],
  control: false,
  dotPose: "waiting",
  attention,
  title: `localDot — ${label}`,
});

const hide = (hidden: boolean) => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

it("leads a hidden tab's title with the amber point only while dot needs you", () => {
  expect(tabTitle(status("needs_you"), true)).toBe("• Needs your answer · localDot");
  expect(tabTitle(status("needs_you"), false)).toBe("localDot — Needs your answer");
  expect(tabTitle(status("working", "Thinking"), true)).toBe("localDot — Thinking");
});

it("gives the tab's icon the amber point while hidden and puts it back on return", () => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" />';
  const link = document.querySelector("link") as HTMLLinkElement;
  hide(false);
  renderHook(() => useTabAttention(status("needs_you")));
  expect(link.getAttribute("href")).toBe("/favicon.svg");
  expect(document.title).toBe("localDot — Needs your answer");
  act(() => hide(true));
  expect(link.getAttribute("href")).toMatch(/^data:image\/svg\+xml,.*e9b44c/);
  expect(document.title).toBe("• Needs your answer · localDot");
  act(() => hide(false));
  expect(link.getAttribute("href")).toBe("/favicon.svg");
});
