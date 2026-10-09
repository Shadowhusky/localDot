// @vitest-environment jsdom
import { VIEWER_LIMITS } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../lib/api.ts";
import { DeliverableFile } from "../DeliverableFile.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { FileViewerScope, type ViewerEntry } from "./scope.tsx";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const RESULT = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R";
const TICKET = "t".repeat(43);
afterEach(cleanup);

function daemon(page = '<img src="https://images.example.test/a.png"><p>hi</p>') {
  const calls: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname.endsWith("/preview-link"))
        return Response.json({ base: `/file-previews/${TICKET}/` });
      if (u.pathname.endsWith("/text"))
        return Response.json({
          kind: "text",
          from: "start",
          lines: page.split("\n"),
          truncated: false,
        });
      return new Response("not found", { status: 404 });
    },
  });
  return { api, calls };
}
const entry = (name: string, bytes = 100): ViewerEntry => ({
  resultId: RESULT,
  sessionId: ID,
  file: { name, path: `Documents/${name}`, bytes, version: 1 },
});
const downloads = {
  state: () => undefined,
  busy: false,
  request: vi.fn(async () => true),
  sessionId: ID,
};

function viewer(api: ReturnType<typeof daemon>["api"], entries: ViewerEntry[], index = 0) {
  const onIndex = vi.fn();
  const view = render(
    <FileViewer
      api={api}
      entries={entries}
      index={index}
      open
      downloads={downloads}
      onMac={false}
      onIndex={onIndex}
      onClose={() => {}}
    />,
  );
  return {
    onIndex,
    rerender: (next: number) =>
      view.rerender(
        <FileViewer
          api={api}
          entries={entries}
          index={next}
          open
          downloads={downloads}
          onMac={false}
          onIndex={onIndex}
          onClose={() => {}}
        />,
      ),
  };
}

describe("the full preview", () => {
  it("frames a page in an empty sandbox from the task's preview link, and says what it leaves out", async () => {
    const { api } = daemon();
    viewer(api, [entry("page.html")]);
    const frame = await screen.findByTitle("Page page.html");
    expect(frame.tagName).toBe("IFRAME");
    // No token at all: no scripts, no same origin, no forms, popups or top navigation.
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("allow")).toBeNull();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe(
      `http://127.0.0.1:4750/file-previews/${TICKET}/page.html?v=1`,
    );
    expect(await screen.findByText("Pictures from the web are not loaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(await screen.findByRole("region", { name: "Source of page.html" })).toBeTruthy();
  });

  it("draws an SVG as a picture, never as part of the page", async () => {
    const { api } = daemon();
    viewer(api, [entry("diagram.svg")]);
    const picture = await screen.findByRole("img", { name: "diagram.svg" });
    expect(picture.tagName).toBe("IMG");
    expect(picture.getAttribute("src")).toBe(
      `http://127.0.0.1:4750/file-previews/${TICKET}/diagram.svg?v=1`,
    );
    expect(document.querySelector("iframe, object, embed")).toBeNull();
  });

  it("says a file is too large without loading it", async () => {
    const { api, calls } = daemon();
    viewer(api, [entry("photo.png", VIEWER_LIMITS.pictureBytes + 1)]);
    expect(await screen.findByText("Too large to preview")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("moves between the files with the arrow keys and the buttons", async () => {
    const { api } = daemon();
    const { onIndex, rerender } = viewer(api, [entry("a.zip"), entry("b.zip"), entry("c.zip")]);
    expect(screen.getByText("1 of 3")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
    });
    expect(onIndex).toHaveBeenLastCalledWith(1);
    rerender(2);
    await waitFor(() => expect(screen.getByText("3 of 3")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(onIndex).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous file" }));
    expect(onIndex).toHaveBeenLastCalledWith(1);
    expect(screen.getByText("No preview for this kind of file")).toBeTruthy();
  });

  it("opens from a file's row, and the row points there for a file it can't draw inline", async () => {
    const { api } = daemon();
    const row = entry("diagram.svg");
    render(
      <FileViewerScope api={api} entries={[row]} downloads={downloads} onMac={false}>
        <ul>
          <DeliverableFile
            api={api}
            sessionId={ID}
            resultId={RESULT}
            file={row.file}
            downloads={{ ...downloads, cancel: vi.fn() }}
            refresh={1}
            defaultOpen
            onMac={false}
          />
        </ul>
      </FileViewerScope>,
    );
    expect(screen.getByText("Press Open to see this file.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open diagram.svg" }));
    expect(await screen.findByRole("img", { name: "diagram.svg" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
