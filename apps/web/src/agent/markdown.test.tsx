// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
