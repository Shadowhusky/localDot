// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../../lib/api.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { TextView } from "./TextView.tsx";

afterEach(cleanup);
const markdown =
  "# Report\n\n**Ready** and [details](https://example.com).\n\n<script>alert(1)</script>\n\n```js\nconst answer = 42;\n```";

it("switches between rendered Markdown and escaped source without executing markup", () => {
  const { container } = render(<MarkdownView name="report.md" text={markdown} />);
  expect(screen.getByRole("heading", { name: "Report" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "details" }).getAttribute("href")).toBe(
    "https://example.com/",
  );
  fireEvent.click(screen.getByRole("radio", { name: "Source" }));
  expect(screen.getByRole("region", { name: "Source of report.md" }).textContent).toContain(
    "**Ready**",
  );
  expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
  expect(screen.getByRole("heading", { name: "Report" })).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});

it("saved Markdown toggles reuse the loaded file rather than fetching or calling the model again", async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ kind: "text", from: "start", lines: markdown.split("\n"), truncated: false }),
  );
  const api = createApi("token", { fetchImpl });
  render(
    <TextView
      api={api}
      file={{ sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", name: "report.md", version: 1 }}
    />,
  );
  await screen.findByRole("heading", { name: "Report" });
  fireEvent.click(screen.getByRole("radio", { name: "Source" }));
  fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
