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

function daemon(
  page = '<img src="https://images.example.test/a.png"><p>hi</p>',
  tickets = () => TICKET,
) {
  const calls: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname.endsWith("/preview-link"))
        return Response.json({ base: `/file-previews/${tickets()}/` });
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
  blocked: () => undefined,
  request: vi.fn(),
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
  it.each(["Makefile", "settings.env", "settings.unfamiliar"])(
    "opens %s as escaped text",
    async (name) => {
      const { api } = daemon("<script>window.unwanted = true</script>\nPORT=3000");
      viewer(api, [entry(name)]);
      const contents = await screen.findByRole("region", { name: `Contents of ${name}` });
      expect(contents.textContent).toContain("<script>");
      expect(contents.querySelector("script")).toBeNull();
    },
  );
  it("shows what a version changed from the one before it", async () => {
    const version = (n: number) => ({
      sessionId: ID,
      version: n,
      label: n,
      bytes: 20,
      resultId: RESULT,
      tMs: n * 1000,
      available: true,
    });
    const calls: string[] = [];
    const api = createApi("a".repeat(43), {
      origin: "http://127.0.0.1:4750",
      fetchImpl: async (url) => {
        const u = new URL(String(url));
        calls.push(`${u.pathname}${u.search}`);
        if (u.pathname.endsWith("/versions"))
          return Response.json({ name: "notes.txt", versions: [version(1), version(2)] });
        if (u.pathname.endsWith("/compare"))
          return Response.json({
            from: 1,
            to: 2,
            patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-draft\n+final\n",
            truncated: false,
          });
        return Response.json({ kind: "text", from: "start", lines: ["final"], truncated: false });
      },
    });
    viewer(api, [{ ...entry("notes.txt"), file: { ...entry("notes.txt").file, version: 2 } }]);
    fireEvent.click(await screen.findByRole("radio", { name: "Changes" }));
    const changes = await screen.findByRole("region", { name: "Changes to notes.txt" });
    expect(changes.textContent).toContain("final");
    expect(screen.getByText("v1 → v2")).toBeTruthy();
    expect(calls).toContain(
      `/api/agent/sessions/${ID}/files/notes.txt/compare?from=${ID}.1&to=${ID}.2`,
    );
  });
  it("explains binary files and offers a download", async () => {
    const api = createApi("a".repeat(43), {
      fetchImpl: async () => Response.json({ kind: "none", reason: "binary" }),
    });
    viewer(api, [entry("archive.unknown")]);
    expect(await screen.findByText("This file isn't text")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
  });
  it("lets a failed text request retry without closing the file", async () => {
    let calls = 0;
    const api = createApi("a".repeat(43), {
      fetchImpl: async () =>
        ++calls === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ kind: "text", lines: ["Recovered"], from: "start", truncated: false }),
    });
    viewer(api, [entry("notes.custom")]);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Contents of notes.custom" })).toBeTruthy();
    expect(screen.getByText("Recovered")).toBeTruthy();
  });
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

  it("says how to have the keys back once the page holds them", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      const { api } = daemon("<p>hi</p>");
      viewer(api, [entry("page.html")]);
      const frame = await screen.findByTitle("Page page.html");
      const hint = "Click outside the page to use Esc and the arrow keys";
      act(() => frame.focus());
      fireEvent.blur(window);
      expect(await screen.findByText(hint)).toBeTruthy();
      act(() => screen.getAllByRole("button", { name: "Download" })[0]?.focus());
      fireEvent.focus(window);
      await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("shows a kept link at once and takes the daemon's new one after it restarts", async () => {
    let ticket = TICKET;
    const { api } = daemon(undefined, () => ticket);
    viewer(api, [entry("chart.png")]);
    const src = async () =>
      (await screen.findByRole("img", { name: "chart.png" })).getAttribute("src");
    expect(await src()).toContain(TICKET);
    cleanup();
    ticket = "r".repeat(43);
    viewer(api, [entry("chart.png")]);
    expect(await src()).toContain(TICKET);
    await waitFor(async () => expect(await src()).toContain(ticket));
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
    expect(await screen.findByRole("region", { name: "Contents of c.zip" })).toBeTruthy();
  });

  it("opens from a file's row, and the row points there for a file it can't draw inline", async () => {
    const { api } = daemon();
    const row = entry("diagram.svg");
    const results = {
      state: () => undefined,
      busy: false,
      request: vi.fn(async () => true),
      cancel: vi.fn(),
      sessionId: ID,
    };
    render(
      <FileViewerScope api={api} entries={[row]} downloads={results} onMac={false}>
        <ul>
          <DeliverableFile
            api={api}
            sessionId={ID}
            resultId={RESULT}
            file={row.file}
            downloads={results}
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
