// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import attentionIcon from "../favicon-attention.svg";
import type { Status } from "../session/status.ts";
import { tabTitle, useTabAttention } from "./tab-attention.ts";

const status = (attention: Status["attention"], label = "Needs your answer"): Status => ({
  row: "question",
  computer: "live",
  label,
  caption: { speaker: "dot", text: "" },
  elapsedS: 12,
  countdownS: null,
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
  cleanup();
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
  expect(link.getAttribute("href")).toBe(attentionIcon);
  expect(document.title).toBe("• Needs your answer · localDot");
  act(() => hide(false));
  expect(link.getAttribute("href")).toBe("/favicon.svg");
});

it("says what waits across tasks while hidden, counting once there is more than one", () => {
  const working = status("working", "Thinking");
  expect(tabTitle(working, true, { count: 1, top: "done" })).toBe("Done · localDot");
  expect(tabTitle(working, true, { count: 2, top: "failed" })).toBe("(2) Failed · localDot");
  expect(tabTitle(working, true, { count: 1, top: "blocked" })).toBe("Paused · localDot");
  expect(tabTitle(working, true, { count: 2, top: "needs_you" })).toBe(
    "• (2) Needs you · localDot",
  );
  expect(tabTitle(status("needs_you"), true, { count: 2, top: "needs_you" })).toBe(
    "• (2) Needs your answer · localDot",
  );
  expect(tabTitle(working, false, { count: 2, top: "needs_you" })).toBe("localDot — Thinking");
  expect(tabTitle(working, true, { count: 0, top: "none" })).toBe("localDot — Thinking");
});

it("marks the tab's icon while another task needs you out of sight", () => {
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" />';
  const link = document.querySelector("link") as HTMLLinkElement;
  hide(true);
  const view = renderHook(
    ({ top }) => useTabAttention(status("working", "Thinking"), { count: 1, top }),
    {
      initialProps: { top: "needs_you" as "needs_you" | "done" },
    },
  );
  expect(link.getAttribute("href")).toBe(attentionIcon);
  expect(document.title).toBe("• Needs you · localDot");
  view.rerender({ top: "done" });
  expect(link.getAttribute("href")).toBe("/favicon.svg");
  expect(document.title).toBe("Done · localDot");
});

it("restores the PNG mascot metadata after the SVG attention badge", () => {
  document.head.innerHTML =
    '<link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />';
  const link = document.querySelector("link") as HTMLLinkElement;
  hide(false);
  renderHook(() => useTabAttention(status("needs_you")));
  act(() => hide(true));
  expect(link.type).toBe("image/svg+xml");
  expect(link.getAttribute("sizes")).toBe("any");
  act(() => hide(false));
  expect(link.getAttribute("href")).toBe("/icons/icon-192.png");
  expect(link.type).toBe("image/png");
  expect(link.getAttribute("sizes")).toBe("192x192");
});
