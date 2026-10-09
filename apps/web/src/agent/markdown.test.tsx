// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_LIMITS, markdownToPlain, parseMarkdown, safeMarkdownLink } from "./markdown.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

afterEach(cleanup);
describe("bounded explicit Markdown display", () => {
  it("renders paragraphs, emphasis, lists, inline code and fenced code as ordinary text nodes", () => {
    const { container } = render(
      <SafeMarkdown
        text={
          "# A heading\n\nA **bold** and *soft* word with `code`.\n\n- first\n- second\n\n```html\n<img src=x onerror=alert(1)>\n```"
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "A heading" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("soft");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre")?.textContent).toContain("<img");
    expect(container.querySelector("img")).toBeNull();
  });
  it("never interprets raw HTML, scripts, SVG or Markdown media as DOM or auto-loads", () => {
    const text =
      '<script>alert(1)</script><svg onload="alert(2)"><image href="https://example.test/x"/></svg>\n\n![remote](https://example.test/image.png)';
    const { container } = render(<SafeMarkdown text={text} />);
    expect(
      container.querySelectorAll(
        "script,svg:not(.ui-icon),img,image,iframe,object,embed,audio,video,style",
      ),
    ).toHaveLength(0);
    // A picture is never loaded: it shows as a chip linking to it, named by its host.
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Image · example.test"]);
    expect(links[0]?.getAttribute("href")).toBe("https://example.test/image.png");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///private/x",
    "blob:https://example.test/x",
    "codex://x",
    "https://name:password@example.test",
    "https://example.test/\nfoo",
    "https://example.test/\u0000",
  ])("does not make an executable or credential-bearing link for %s", (url) => {
    expect(safeMarkdownLink(url)).toBeNull();
    const { container } = render(<SafeMarkdown text={`[label](${url})`} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
  it("names the host a link goes to beside it", () => {
    const { container } = render(
      <SafeMarkdown text="Rules from the [finance handbook](https://www.handbook.example.test/finance#4)" />,
    );
    expect(screen.getByRole("link", { name: "finance handbook" })).toBeTruthy();
    expect(container.querySelector(".md-host")?.textContent).toBe("handbook.example.test");
  });
  it("allows only explicit http/https navigation with opener and referrer protections", () => {
    render(
      <SafeMarkdown text="[Read reference](https://example.test/reference)\n\nhttps://example.test/plain" />,
    );
    const link = screen.getByRole("link", { name: "Read reference" });
    expect(link.getAttribute("href")).toBe("https://example.test/reference");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("keeps malformed and deeply nested input bounded without dropping the remaining text", () => {
    const parsed = parseMarkdown("[".repeat(20_000));
    expect(parsed.blocks).toHaveLength(1);
    render(<SafeMarkdown text={"**x** ".repeat(8000)} />);
    expect(document.querySelectorAll(".safe-markdown *").length).toBeLessThan(1100);
    expect(screen.getByText("Message preview shortened.")).toBeTruthy();
    expect(document.body.textContent?.length).toBeLessThan(MARKDOWN_LIMITS.chars + 100);
  });
});

describe("the Markdown dot writes in a reply", () => {
  it("draws tables, quotes, rules and two heading levels, all as plain text", () => {
    const { container } = render(
      <SafeMarkdown
        text={
          "## Totals\n\n| Month | Net |\n| :--- | ---: |\n| Jan | 9000 |\n| Dec \\| end | 12311 |\n\n> Checked against **the sheet**\n> twice\n\n---\n\n### Notes\n\nDone."
        }
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Totals" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Notes" })).toBeTruthy();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Month", "Net"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Dec | end")).toBeTruthy();
    expect(within(table).getByText("12311").getAttribute("data-align")).toBe("right");
    expect(container.querySelector("blockquote")?.textContent).toBe(
      "Checked against the sheet\ntwice",
    );
    expect(container.querySelector("blockquote strong")?.textContent).toBe("the sheet");
    expect(container.querySelectorAll("hr")).toHaveLength(1);
  });

  it("nests lists three deep, flattens deeper ones and keeps an ordered list's numbering", () => {
    const { container } = render(
      <SafeMarkdown
        text={
          "1. Opened the sheet\n2. Checked each row\n   - recomputed Net\n     - in a scratch column\n       - deeper still\n   - compared it\n3. Wrote the summary"
        }
      />,
    );
    const top = container.querySelector(".safe-markdown > ol") as HTMLElement;
    expect([...top.children].map((item) => item.querySelector(".md-item")?.textContent)).toEqual([
      "Opened the sheet",
      "Checked each row",
      "Wrote the summary",
    ]);
    const second = top.children[1] as HTMLElement;
    expect(second.querySelectorAll(":scope > ul > li")).toHaveLength(2);
    const third = second.querySelector(":scope > ul > li > ul") as HTMLElement;
    expect([...third.children].map((item) => item.textContent)).toEqual([
      "in a scratch column",
      "deeper still",
    ]);
    expect(container.querySelectorAll("ol, ul")).toHaveLength(3);
  });
  it("draws a task list's boxes, done or still to do, without a control to change them", () => {
    const { container } = render(
      <SafeMarkdown text={"- [x] Check the totals\n- [ ] Add a chart"} />,
    );
    expect(screen.getAllByRole("img").map((box) => box.getAttribute("aria-label"))).toEqual([
      "Done",
      "To do",
    ]);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("[x]");
  });
  it("right-aligns a column of numbers unless the table aligns it itself", () => {
    render(
      <SafeMarkdown
        text={
          "| Month | Net | Note |\n| --- | --- | :--- |\n| Jan | 9,000 | 12 |\n| Feb | $9,301 | 4 |"
        }
      />,
    );
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.getAttribute("data-align"))).toEqual([
      null,
      "right",
      "left",
      null,
      "right",
      "left",
    ]);
  });
  it("redraws only the block that changes as a message streams in", () => {
    const first = "## Totals\n\nAll months match.";
    const { container, rerender } = render(<SafeMarkdown text={`${first}\n\nChecking`} />);
    const heading = container.querySelector("h3");
    const paragraph = container.querySelector("p");
    rerender(<SafeMarkdown text={`${first}\n\nChecking each row`} />);
    expect(container.querySelector("h3")).toBe(heading);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelectorAll("p")[1]?.textContent).toBe("Checking each row");
  });
  it("reads streaming text again at most every tenth of a second, and finished text at once", async () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<SafeMarkdown text="One" streaming />);
      rerender(<SafeMarkdown text="One two" streaming />);
      rerender(<SafeMarkdown text="One two three" streaming />);
      expect(container.textContent).toBe("One");
      await act(async () => vi.advanceTimersByTime(100));
      expect(container.textContent).toBe("One two three");
      rerender(<SafeMarkdown text="One two three four." />);
      expect(container.textContent).toBe("One two three four.");
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads streamed text in the render that brings it once the last read is old enough", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { container, rerender } = render(<SafeMarkdown text="One" streaming />);
      now += 100;
      rerender(<SafeMarkdown text="One two" streaming />);
      expect(container.textContent).toBe("One two");
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("gives a table's first row a row's height until its delimiter arrives", () => {
    expect(parseMarkdown("Totals:\n\n| Month | Net |").blocks.at(-1)).toMatchObject({
      kind: "paragraph",
      pendingRow: true,
    });
    expect(parseMarkdown("| Month | Net |\n| --- | --- |").blocks[0]?.kind).toBe("table");
  });
  it("names a code block by its language and copies only its code", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SafeMarkdown text={"```python\nprint('hi')\n```"} />);
    const code = screen.getByRole("region", { name: "python" });
    await act(async () => fireEvent.click(within(code).getByRole("button", { name: "Copy code" })));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("print('hi')");
  });

  it("is not a table without a matching delimiter row, and stays fast on long space runs", () => {
    expect(parseMarkdown("a | b\n---").blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "rule",
    ]);
    const started = performance.now();
    parseMarkdown(`| a |\n|-${" ".repeat(20_000)}x\n# a${" ".repeat(20_000)}b`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("dot's Markdown as one plain line", () => {
  it.each([
    ["## Summary\n\nI **couldn't** create `notes.md`.", "Summary · I couldn't create notes.md."],
    [
      "I couldn't create the file.\n\nWhat I checked:\n- This computer has no printer\n- The driver is *missing*",
      "I couldn't create the file. What I checked: This computer has no printer · The driver is missing",
    ],
    [
      "1. Open the sheet\n2. Add the totals\n   - by month",
      "Open the sheet · Add the totals · by month",
    ],
    ["- [x] Booked\n- [ ] Paid", "Booked · Paid"],
    ["See [the sheet](https://x.test/s) and [notes](notes/today.md).", "See the sheet and notes."],
    ["![the chart](https://x.test/c.png)", "the chart"],
    ["Run this:\n\n```sh\nls   -la\n```", "Run this: ls -la"],
    ["> Quoted __words__ here", "Quoted words here"],
    ["| Month | Total |\n| --- | ---: |\n| May | 12 |", "Month · Total · May · 12"],
    ["---\n\n#### Done", "Done"],
    ["  Many\t\tspaces\n  and lines  ", "Many spaces and lines"],
    ["Plain words, snake_case_name and 5 * 3.", "Plain words, snake_case_name and 5 * 3."],
    ["\\*not emphasis\\*", "*not emphasis*"],
    ["", ""],
  ])("reads %j as %j", (text, plain) => {
    expect(markdownToPlain(text)).toBe(plain);
  });

  it.each([
    "\u202e",
    "\u2066",
    "\u200f",
    "\u061c",
    "\u200b",
    "\u00ad",
    "\u00a0",
    "\u3000",
    "\u{e0041}",
  ])("keeps the hidden character %j wherever the marks put it", (hidden) => {
    for (const text of [
      `**Pay${hidden}now**`,
      `# Pay${hidden}now`,
      `- Pay${hidden}now`,
      `Pay \`${hidden}\` now`,
      `[Pay${hidden}now](https://x.test)`,
      `> Pay${hidden}now`,
    ])
      expect(markdownToPlain(text)).toContain(hidden);
  });

  it("keeps marks as written when they alone hold a hidden character", () => {
    expect(markdownToPlain("[invoice](https://x.test/\u202epdf.exe)")).toBe(
      "[invoice](https://x.test/\u202epdf.exe)",
    );
    expect(markdownToPlain("-\u00a0item")).toBe("-\u00a0item");
    expect(markdownToPlain("one\rtwo")).toBe("one\rtwo");
    expect(markdownToPlain("**Pay** \u202eit [here](https://x.test/\u202e)")).toBe(
      "Pay \u202eit here",
    );
  });
});
