// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_LIMITS, parseMarkdown, safeMarkdownLink } from "./markdown.ts";
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
      container.querySelectorAll("script,svg,img,image,iframe,object,embed,audio,video,style"),
    ).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("![remote](https://example.test/image.png)");
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
