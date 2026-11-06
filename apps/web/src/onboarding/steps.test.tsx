// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { KeyStep, ModelStep } from "./steps.tsx";
import { ViewStylePicker } from "./ViewStylePicker.tsx";

afterEach(cleanup);

const step = (unavailable?: string) => (
  <KeyStep
    kind="api"
    provider="anthropic"
    onProvider={vi.fn()}
    models={[]}
    secret={createRef<HTMLInputElement>()}
    saved={null}
    unavailable={unavailable}
    onTyped={vi.fn()}
  />
);

it("offers both view styles, each described, with the device's recommendation marked", () => {
  const onChange = vi.fn();
  render(<ViewStylePicker aria-label="View" value="chat" recommended="chat" onChange={onChange} />);
  const group = screen.getByRole("radiogroup", { name: "View" });
  const chat = within(group).getByRole("radio", { name: /^Chat/ });
  const studio = within(group).getByRole("radio", { name: /^Studio/ });
  expect((chat as HTMLInputElement).checked).toBe(true);
  expect(chat.closest("label")?.textContent).toContain("Recommended");
  expect(studio.closest("label")?.textContent).not.toContain("Recommended");
  expect(studio.closest("label")?.textContent).toContain("on one screen");
  fireEvent.click(studio);
  expect(onChange).toHaveBeenCalledWith("studio");
});

it("shows the command that turns key protection back on while it is off", () => {
  const view = render(step("Key protection is off. To turn it back on, run this in Terminal:"));
  expect(screen.getByText(/To turn it back on, run this in Terminal/)).toBeTruthy();
  expect(screen.getByText("localdot doctor")).toBeTruthy();
  view.rerender(step());
  expect(screen.queryByText("localdot doctor")).toBeNull();
});

it("offers an in-place model-list retry and distinguishes loading from failure", () => {
  const onRefresh = vi.fn();
  const props = {
    kind: "api" as const,
    provider: "deepseek",
    models: [],
    allModels: [],
    subscriptionModels: [],
    main: "",
    typedModel: "",
    fast: false,
    fastAvailable: false,
    fastModel: "",
    plan: false,
    price: { input: "", output: "" },
    fastPrice: { input: "", output: "" },
    onMain: vi.fn(),
    onFast: vi.fn(),
    onFastModel: vi.fn(),
    onPlan: vi.fn(),
    onPrice: vi.fn(),
    onFastPrice: vi.fn(),
    onRefresh,
  };
  const view = render(<ModelStep {...props} />);
  expect(screen.getByText(/Your saved key is kept/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  view.rerender(<ModelStep {...props} loading />);
  expect(screen.getByRole("status").textContent).toContain("Loading models");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it("asks a custom endpoint for its fast model by name, on the same server, and its price when priced per token", () => {
  const onFastModel = vi.fn();
  const props = {
    kind: "custom" as const,
    provider: "openai-responses-compatible",
    models: [],
    allModels: [],
    subscriptionModels: [],
    main: "gpt-6.1-sol",
    typedModel: "gpt-6.1-sol",
    fast: false,
    fastAvailable: false,
    fastModel: "",
    plan: false,
    price: { input: "2", output: "10" },
    fastPrice: { input: "", output: "" },
    onMain: vi.fn(),
    onFast: vi.fn(),
    onFastModel,
    onPlan: vi.fn(),
    onPrice: vi.fn(),
    onFastPrice: vi.fn(),
  };
  const view = render(<ModelStep {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Fast model" }), {
    target: { value: "gpt-6-luna" },
  });
  expect(onFastModel).toHaveBeenCalledWith("gpt-6-luna");
  expect(screen.queryByRole("textbox", { name: "Fast model input" })).toBeNull();
  view.rerender(<ModelStep {...props} fastModel="gpt-6-luna" />);
  expect(screen.getByRole("textbox", { name: "Fast model input" })).toBeTruthy();
  view.rerender(<ModelStep {...props} fastModel="gpt-6-luna" plan />);
  expect(screen.queryByRole("textbox", { name: "Fast model input" })).toBeNull();
});
