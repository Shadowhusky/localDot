// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccessoryPicker } from "./AccessoryPicker.tsx";

afterEach(cleanup);

it("offers no accessory or one of four, with the chosen one checked", () => {
  const onChange = vi.fn();
  render(<AccessoryPicker persona="coder" value="cap" onChange={onChange} />);
  expect(
    screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-labelledby")),
  ).toHaveLength(5);
  expect(screen.getByRole("radio", { name: "Cap" })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("radio", { name: "Bow" }));
  expect(onChange).toHaveBeenLastCalledWith("bow");
  fireEvent.click(screen.getByRole("radio", { name: "None" }));
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});
