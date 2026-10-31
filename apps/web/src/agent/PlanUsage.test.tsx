// @vitest-environment jsdom
import type { PlanUsage, PlanUsageReply } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGroup } from "../settings/model-options.ts";
import { ModelChip } from "./ModelChip.tsx";
import type { PlanUsageFeed } from "./usePlanUsage.ts";

afterEach(cleanup);

const HOUR = 3_600_000;
const seconds = (ms: number) => Math.round(ms / 1000);
const claudeGroup: ModelGroup = {
  label: "Claude Code",
  options: [
    {
      id: "cc-sonnet",
      name: "Claude Sonnet",
      choice: { provider: "claude-code", model: "sonnet" },
    },
  ],
};
const chatgptGroup: ModelGroup = {
  label: "ChatGPT plan",
  options: [
    { id: "gpt-plan", name: "Sample plan model", choice: { provider: "chatgpt", model: "plan" } },
  ],
};
const apiGroup: ModelGroup = {
  label: "Anthropic",
  options: [
    {
      id: "sonnet",
      name: "Claude Sonnet 5.5",
      choice: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    },
  ],
};
function claude(used: [number, number], over: Partial<PlanUsage> = {}): PlanUsage {
  const now = Date.now();
  return {
    provider: "claude-code",
    plan: "max",
    windows: [
      {
        window: "primary",
        usedPercent: used[0],
        windowMinutes: 300,
        resetsAt: seconds(now + 2 * HOUR + 14 * 60_000),
        observedAt: now,
      },
      {
        window: "secondary",
        usedPercent: used[1],
        windowMinutes: 10_080,
        resetsAt: seconds(now + 4 * 24 * HOUR),
        observedAt: now,
      },
    ],
    limitReached: false,
    observedAt: now,
    ...over,
  };
}
function feed(plans: PlanUsage[], checking: PlanUsageReply["checking"] = []) {
  const stop = vi.fn();
  const usage: PlanUsageFeed = {
    reply: { plans, checking },
    refresh: vi.fn(),
    watch: vi.fn(() => stop),
  };
  return { usage, stop };
}
function open(usage: PlanUsageFeed, groups: ModelGroup[] = [apiGroup, claudeGroup]) {
  render(
    <ModelChip
      name="Claude Sonnet"
      groups={groups}
      current="cc-sonnet"
      choice={{ provider: "claude-code", model: "sonnet" }}
      onChoose={vi.fn()}
      onManage={vi.fn()}
      usage={usage}
    />,
  );
  const chip = screen.getByRole("button", { name: /^Model/ });
  fireEvent.click(chip);
  return { chip, panel: screen.getByRole("dialog", { name: "Model and thinking" }) };
}
const plan = (panel: HTMLElement, name: RegExp) => within(panel).getByRole("region", { name });

describe("plan usage in the model menu", () => {
  it("shows each plan's 5-hour and weekly limits with when they reset", () => {
    const { usage, stop } = feed([claude([42, 12])]);
    const { chip, panel } = open(usage);
    expect(usage.watch).toHaveBeenCalledOnce();
    expect(chip.getAttribute("aria-label")).toBe("Model: Claude Sonnet");
    const block = plan(panel, /^Claude plan · Max$/);
    const meters = within(block).getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-valuetext"))).toEqual([
      "42% used",
      "12% used",
    ]);
    expect(within(block).getByRole("meter", { name: "5-hour limit" })).toBeTruthy();
    expect(within(block).getByRole("meter", { name: "Weekly limit" })).toBeTruthy();
    const resets = block.querySelectorAll("time");
    expect(resets[0]?.textContent).toMatch(/^Resets in 2 h 1[34] min, /);
    expect(resets[0]?.getAttribute("title")).toMatch(/\d:\d\d/);
    expect(resets[1]?.textContent).toMatch(/^Resets in (3 days 23 h|4 days)/);
    expect(block.textContent).not.toMatch(/As of|Limit reached/);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("marks a plan near its limit, in the menu and on the chip", () => {
    const { usage } = feed([claude([93, 40])]);
    const { chip, panel } = open(usage);
    expect(chip.getAttribute("aria-label")).toBe(
      "Model: Claude Sonnet, Claude plan almost at limit",
    );
    expect(within(chip).getByRole("img", { name: "Claude plan almost at limit" })).toBeTruthy();
    const block = plan(panel, /^Claude plan/);
    expect(within(block).getByRole("img", { name: "Almost at limit" })).toBeTruthy();
    expect(
      within(block).getByRole("meter", { name: "5-hour limit" }).getAttribute("aria-valuetext"),
    ).toBe("93% used, almost at limit");
  });

  it("says when a reached limit resets", () => {
    const { usage } = feed([
      claude([100, 64], {
        limitReached: true,
        limitResetsAt: seconds(Date.now() + 90 * 60_000),
      }),
    ]);
    const { chip, panel } = open(usage);
    expect(chip.getAttribute("aria-label")).toBe("Model: Claude Sonnet, Claude plan limit reached");
    const block = plan(panel, /^Claude plan/);
    expect(block.querySelector(".plan-usage-limit")?.textContent).toMatch(
      /^Limit reached · resets in 1 h 30 min, /,
    );
    expect(block.querySelector(".plan-usage-window")?.getAttribute("data-tone")).toBe("limit");
  });

  it("dates stale figures and shows a window past its reset as reset", () => {
    const old = Date.now() - 3 * HOUR;
    const stale = claude([96, 30]);
    stale.windows = stale.windows.map((row) => ({ ...row, observedAt: old }));
    stale.windows[0] = { ...stale.windows[0], resetsAt: seconds(Date.now() - HOUR) } as never;
    const { usage } = feed([{ ...stale, observedAt: old }]);
    const { chip, panel } = open(usage);
    const block = plan(panel, /^Claude plan/);
    expect(block.textContent).toContain("As of 3 h ago");
    const reset = within(block).getByRole("meter", { name: "5-hour limit" });
    expect(reset.getAttribute("aria-valuenow")).toBe("0");
    expect(reset.getAttribute("aria-valuetext")).toBe("Reset");
    expect(block.textContent).toMatch(/Reset .*\. New usage not known yet\./);
    expect(chip.getAttribute("aria-label")).toBe("Model: Claude Sonnet");
  });

  it("says quietly when a plan's usage is not known yet, or is being read", () => {
    open(feed([]).usage, [chatgptGroup, claudeGroup]);
    const panel = screen.getByRole("dialog", { name: "Model and thinking" });
    expect(
      within(panel)
        .getAllByRole("region")
        .map((region) => region.textContent),
    ).toEqual(["Claude planUsage appears after the first reply."]);
    cleanup();
    open(feed([], ["claude-code"]).usage);
    expect(plan(screen.getByRole("dialog"), /^Claude plan$/).textContent).toContain(
      "Checking usage…",
    );
  });

  it("shows nothing before the figures have loaded", () => {
    const { usage } = feed([]);
    const { panel } = open({ ...usage, reply: null });
    expect(usage.watch).toHaveBeenCalledOnce();
    expect(within(panel).queryByRole("region")).toBeNull();
  });

  it("shows nothing for a model billed by the call, though the menu offers a plan", () => {
    const { usage } = feed([claude([42, 12])]);
    render(
      <ModelChip
        name="Claude Sonnet 5.5"
        groups={[apiGroup, claudeGroup, chatgptGroup]}
        current="sonnet"
        choice={{ provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" }}
        onChoose={vi.fn()}
        onManage={vi.fn()}
        usage={usage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    const panel = screen.getByRole("dialog");
    expect(within(panel).queryByRole("region")).toBeNull();
    fireEvent.click(within(panel).getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet" }));
    expect(within(panel).getAllByRole("region")).toHaveLength(1);
    expect(plan(panel, /^Claude plan · Max$/)).toBeTruthy();
  });

  it("shows the plan of the model chosen in the menu, and only that one", () => {
    const { usage } = feed([claude([42, 12])]);
    const { panel } = open(usage, [claudeGroup, chatgptGroup]);
    expect(within(panel).getAllByRole("region")).toHaveLength(1);
    expect(plan(panel, /^Claude plan · Max$/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: "Sample plan model" }));
    expect(within(panel).getAllByRole("region")).toHaveLength(1);
    expect(plan(panel, /^ChatGPT plan$/).textContent).toContain(
      "Usage appears after the first reply.",
    );
  });
});
