// @vitest-environment jsdom
import { CSPProvider } from "@base-ui/react/csp-provider";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { KitProvider } from "./KitProvider.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select.tsx";

afterEach(cleanup);

function OpenSelect() {
  return (
    <Select defaultOpen defaultValue="1">
      <SelectTrigger aria-label="Speed">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1">1×</SelectItem>
        <SelectItem value="2">2×</SelectItem>
      </SelectContent>
    </Select>
  );
}

async function styleElementsWith(tree: ReactNode) {
  render(tree);
  await screen.findByRole("listbox");
  return document.querySelectorAll("style").length;
}

it("keeps Base UI from rendering style elements the page CSP would block", async () => {
  expect(
    await styleElementsWith(
      <KitProvider>
        <OpenSelect />
      </KitProvider>,
    ),
  ).toBe(0);
});

it("would otherwise render one for an open select", async () => {
  expect(
    await styleElementsWith(
      <KitProvider>
        <CSPProvider disableStyleElements={false}>
          <OpenSelect />
        </CSPProvider>
      </KitProvider>,
    ),
  ).toBeGreaterThan(0);
});
