// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useHandler } from "./useHandler.ts";

it("keeps one identity and runs the latest render's code", () => {
  const { result, rerender } = renderHook(({ n }) => useHandler((add: number) => n + add), {
    initialProps: { n: 1 },
  });
  const first = result.current;
  expect(first(1)).toBe(2);
  rerender({ n: 10 });
  expect(result.current).toBe(first);
  expect(first(1)).toBe(11);
});
