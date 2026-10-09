// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useId, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "./Field.tsx";
import { SegmentedControl, type SegmentItem } from "./SegmentedControl.tsx";
import { TabPanel, Tabs } from "./Tabs.tsx";

afterEach(cleanup);

const SPEEDS: SegmentItem[] = [
  { value: "slow", label: "0.5×" },
  { value: "normal", label: "1×" },
  { value: "fast", label: "2×", disabledReason: "Faster playback needs a smaller replay" },
  { value: "fastest", label: "4×" },
];

function Speed({ start = "normal" }: { start?: string }) {
  const [value, setValue] = useState(start);
  return (
    <Field label="Speed">
      <SegmentedControl items={SPEEDS} value={value} onValueChange={setValue} />
    </Field>
  );
}

describe("SegmentedControl", () => {
  it("is a radio group whose chosen segment alone takes Tab", () => {
    render(<Speed />);
    screen.getByRole("radiogroup", { name: "Speed" });
    const segments = screen.getAllByRole("radio");
    expect(segments.map((segment) => segment.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(segments.map((segment) => segment.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("moves and chooses with the arrow keys, passing over an unavailable segment", () => {
    render(<Speed />);
    const normal = screen.getByRole("radio", { name: "1×" });
    normal.focus();
    fireEvent.keyDown(normal, { key: "ArrowRight" });
    const fastest = screen.getByRole("radio", { name: "4×" });
    expect(document.activeElement).toBe(fastest);
    expect(fastest.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(fastest, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "0.5×" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(fastest);
  });

  it("slides its thumb by setting the chosen index for the stylesheet", () => {
    const { container } = render(<Speed />);
    const track = container.querySelector(".ui-segmented") as HTMLElement;
    expect(track.style.getPropertyValue("--_count")).toBe("4");
    expect(track.style.getPropertyValue("--_index")).toBe("1");
    fireEvent.click(screen.getByRole("radio", { name: "4×" }));
    expect(track.style.getPropertyValue("--_index")).toBe("3");
  });

  it("puts an amber point on a segment that needs you, without changing its name", () => {
    render(
      <SegmentedControl
        aria-label="Pane"
        size={32}
        items={[
          { value: "chat", label: "Chat", attention: true },
          { value: "activity", label: "Activity" },
        ]}
        value="activity"
        onValueChange={() => {}}
      />,
    );
    const chat = screen.getByRole("radio", { name: "Chat" });
    expect(chat.querySelector(".ui-segment-attention")?.getAttribute("aria-hidden")).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Activity" }).querySelector(".ui-segment-attention"),
    ).toBeNull();
    expect(screen.getByRole("radiogroup").dataset.size).toBe("32");
  });

  it("explains an unavailable segment and keeps its choice", () => {
    render(<Speed />);
    const fast = screen.getByRole("radio", { name: "2×" });
    expect(fast.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(fast.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Faster playback needs a smaller replay");
    fireEvent.click(fast);
    expect(fast.getAttribute("aria-checked")).toBe("false");
  });
});

describe("Tabs", () => {
  function Rail() {
    const id = useId();
    const [tab, setTab] = useState("chat");
    return (
      <>
        <Tabs
          id={id}
          aria-label="Rail"
          items={[
            { value: "chat", label: "Chat" },
            { value: "activity", label: "Activity" },
          ]}
          value={tab}
          onValueChange={setTab}
        />
        <TabPanel tabsId={id} value="chat" selected={tab}>
          <input aria-label="Message dot" />
        </TabPanel>
        <TabPanel tabsId={id} value="activity" selected={tab}>
          Steps
        </TabPanel>
      </>
    );
  }

  it("links each tab to its panel and keeps hidden panels mounted", () => {
    render(<Rail />);
    screen.getByRole("tablist", { name: "Rail" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const panel = document.getElementById(chat.getAttribute("aria-controls") ?? "");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(chat.id);
    const draft = screen.getByRole("textbox", { name: "Message dot" }) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(panel?.hidden).toBe(true);
    fireEvent.click(chat);
    expect(screen.getByRole("textbox", { name: "Message dot" })).toBe(draft);
    expect(draft.value).toBe("half-typed");
  });

  it("goes to the first and last tab with Home and End", () => {
    render(<Rail />);
    const chat = screen.getByRole("tab", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "End" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    expect(document.activeElement).toBe(activity);
    expect(activity.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(activity, { key: "Home" });
    expect(document.activeElement).toBe(chat);
  });
});
