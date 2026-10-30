// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeRow } from "../../agent/ChangeRow.tsx";
import type { AgentChange } from "../../agent/model.ts";
import { StepPreviewButton, StepPreviewScope } from "../../agent/StepPreview.tsx";
import { UserBubble } from "../../agent/UserBubble.tsx";
import { createApi } from "../../lib/api.ts";
import { FileViewer } from "./FileViewer.tsx";
import type { ComputerEntry } from "./scope.tsx";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const TICKET = "t".repeat(43);
const UPLOADS = "~/Downloads/Uploads/0b9f4c1e-6a2d-4f8b-9c3e-1d2a3b4c5d6e";
const PATCH =
  "@@ -1,2 +1,3 @@\n const port = 3000;\n-listen(port);\n+listen(port, host);\n+log(port);\n";
type Computer = "on" | "computer_off" | "busy";

// A daemon whose task listed these files on its computer, as the computer holds them now.
function daemon(files: Record<string, string>, computer: Computer = "on") {
  const calls: string[] = [];
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url, init) => {
      const u = new URL(String(url));
      calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
      if (u.pathname.endsWith("/preview-link"))
        return Response.json({ base: `/file-previews/${TICKET}/` });
      const action = u.pathname.split("/").at(-1);
      const path = u.searchParams.get("path") ?? "";
      const text = files[path];
      if (computer !== "on") return Response.json({ kind: "none", reason: computer });
      if (text === undefined) return Response.json({ kind: "none", reason: "missing" });
      if (action === "about") return Response.json({ kind: "file", path, bytes: text.length });
      if (action === "text")
        return Response.json({
          kind: "text",
          from: "start",
          lines: text.split("\n"),
          truncated: false,
        });
      if (action === "thumbnail")
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      if (action === "download") {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return new Response(text, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { api, calls };
}
const entry = (path: string, patches: string[] = []): ComputerEntry => ({
  sessionId: ID,
  path,
  ...(patches.length
    ? { changes: patches.map((patch) => ({ patch, op: "modify" as const })) }
    : {}),
});
const downloads = { state: () => undefined, blocked: () => undefined, request: vi.fn() };
function viewer(api: ReturnType<typeof daemon>["api"], entries: ComputerEntry[], index = 0) {
  const onIndex = vi.fn();
  const props = { api, entries, open: true, downloads, onMac: false, onIndex, onClose() {} };
  const view = render(<FileViewer {...props} index={index} />);
  return { onIndex, go: (next: number) => view.rerender(<FileViewer {...props} index={next} />) };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("files on dot's computer in the viewer", () => {
  it("shows code with its changes beside it, never an empty Rendered view, and keeps Changes for code", async () => {
    const { api } = daemon({
      "~/app/server.ts": "const port = 3000;\nlisten(port, host);\nlog(port);",
      "~/app/client.ts": "connect();",
    });
    const { go } = viewer(api, [
      entry("~/app/server.ts", [PATCH]),
      entry("~/app/client.ts", ["@@ -0,0 +1 @@\n+connect();"]),
    ]);
    expect(await screen.findByRole("region", { name: "Contents of server.ts" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Rendered" })).toBeNull();
    expect(screen.getByText(/^TypeScript · 49/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Changes" }));
    const changes = await screen.findByRole("region", { name: "Changes to server.ts" });
    expect(changes.textContent).toContain("listen(port, host);");
    expect(within(changes).getAllByText("Removed:", { exact: false })).toHaveLength(1);
    expect(within(changes).getAllByText("Added:", { exact: false })).toHaveLength(2);
    go(1);
    expect(await screen.findByRole("region", { name: "Changes to client.ts" })).toBeTruthy();
  });

  it("offers Rendered and Source for Markdown, and Changes once the task changed it", async () => {
    const { api } = daemon({ "~/Documents/report.md": "# Quarter\n\n- Net up" });
    viewer(api, [entry("~/Documents/report.md", ["@@ -1 +1 @@\n-# Q\n+# Quarter"])]);
    expect(await screen.findByRole("heading", { name: "Quarter" })).toBeTruthy();
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Rendered",
      "Source",
      "Changes",
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(await screen.findByRole("region", { name: "Source of report.md" })).toBeTruthy();
  });

  it("loads a picture by the task's preview link and the file's listed path", async () => {
    const { api } = daemon({ [`${UPLOADS}/photo.png`]: "png" });
    viewer(api, [entry(`${UPLOADS}/photo.png`)]);
    const picture = await screen.findByRole("img", { name: "photo.png" });
    expect(picture.getAttribute("src")).toBe(
      `http://127.0.0.1:4750/file-previews/${TICKET}/computer/photo.png?${new URLSearchParams({ path: `${UPLOADS}/photo.png` })}`,
    );
  });

  it("says why it can't read a file, and why it can't be downloaded", async () => {
    viewer(daemon({}, "computer_off").api, [entry("~/notes.txt")]);
    expect(await screen.findByText("Turn on your computer to see this file")).toBeTruthy();
    const download = screen.getAllByRole("button", { name: "Download" })[0] as HTMLElement;
    expect(download.getAttribute("aria-disabled")).toBe("true");
    cleanup();
    viewer(daemon({}).api, [entry("~/gone.txt")]);
    expect(await screen.findByText("This file is no longer on the computer")).toBeTruthy();
  });

  it("offers a download for a file that isn't text, and asks for it by the file", async () => {
    const { api } = daemon({ [`${UPLOADS}/firmware.bin`]: "\u0000\u0001" });
    vi.spyOn(api, "fetch").mockImplementation(async (url) =>
      new URL(String(url)).pathname.endsWith("/about")
        ? Response.json({ kind: "file", path: `${UPLOADS}/firmware.bin`, bytes: 3_145_728 })
        : Response.json({ kind: "none", reason: "binary" }),
    );
    viewer(api, [entry(`${UPLOADS}/firmware.bin`)]);
    expect(await screen.findByText("This file isn't text")).toBeTruthy();
    expect(screen.getByText(/BIN file · 3(\.\d)? MB/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[0] as HTMLElement);
    expect(downloads.request).toHaveBeenCalledWith(entry(`${UPLOADS}/firmware.bin`), undefined);
  });
});

describe("opening files from where they are listed", () => {
  it("opens a message's files from their chips, a picture showing its thumbnail", async () => {
    const { api, calls } = daemon({
      [`${UPLOADS}/photo.png`]: "png",
      [`${UPLOADS}/main.ts`]: "export const answer = 42;",
    });
    render(
      <StepPreviewScope api={api} sessionId={ID} results={[]}>
        <UserBubble
          text="Here are the files"
          files={[`${UPLOADS}/photo.png`, `${UPLOADS}/main.ts`]}
          lead={null}
          sessionId={ID}
        />
      </StepPreviewScope>,
    );
    await waitFor(() =>
      expect(document.querySelector(".file-chip-thumb")?.getAttribute("src")).toBe(
        "blob:thumbnail",
      ),
    );
    expect(calls.filter((call) => call.includes("/thumbnail"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open photo.png" }));
    const dialog = await screen.findByRole("dialog", { name: "photo.png" });
    expect(within(dialog).getByText("1 of 2")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
    });
    expect(await screen.findByRole("region", { name: "Contents of main.ts" })).toBeTruthy();
  });

  it("leaves a message's chips alone until it has a task to read them from", () => {
    const { api } = daemon({});
    render(
      <StepPreviewScope api={api} sessionId={ID} results={[]}>
        <UserBubble text="On its way" files={[`${UPLOADS}/photo.png`]} lead={null} />
      </StepPreviewScope>,
    );
    expect(screen.queryByRole("button", { name: "Open photo.png" })).toBeNull();
  });

  it("opens and downloads a changed file from its Activity row", async () => {
    const { api, calls } = daemon({ "~/app/server.ts": "const port = 3000;" });
    const change: AgentChange = {
      id: "c1",
      type: "file",
      path: "~/app/server.ts",
      op: "modify",
      patch: PATCH,
      truncated: false,
    };
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <StepPreviewScope api={api} sessionId={ID} results={[]}>
        <ChangeRow id="row" change={change} changes={[change]} open onToggle={() => {}} />
      </StepPreviewScope>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download ~/app/server.ts" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls).toContain(
      `GET /api/agent/sessions/${ID}/computer-files/download?${new URLSearchParams({ path: "~/app/server.ts" })}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open ~/app/server.ts" }));
    expect(await screen.findByRole("region", { name: "Contents of server.ts" })).toBeTruthy();
  });

  it("opens a change's own preview at its changes, and recorded output as plain text", async () => {
    const { api } = daemon({ "~/app/server.ts": "const port = 3000;" });
    const change: AgentChange = {
      id: "c1",
      type: "file",
      path: "~/app/server.ts",
      op: "modify",
      patch: PATCH,
      truncated: false,
    };
    render(
      <StepPreviewScope api={api} sessionId={ID} results={[]}>
        <ChangeRow id="row" change={change} changes={[change]} open onToggle={() => {}} />
        <StepPreviewButton
          label="Preview output"
          resource={{ kind: "text", name: "Output", text: "# not a heading" }}
        />
      </StepPreviewScope>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview code changes" }));
    expect(await screen.findByRole("region", { name: "Changes to server.ts" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Changes" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    cleanup();
    render(
      <StepPreviewScope api={api} sessionId={ID} results={[]}>
        <StepPreviewButton
          label="Preview output"
          resource={{ kind: "text", name: "Output", text: "# not a heading" }}
        />
      </StepPreviewScope>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview output" }));
    const dialog = await screen.findByRole("dialog", { name: "Output" });
    expect(within(dialog).getByRole("region", { name: "Step output preview" }).textContent).toBe(
      "1# not a heading",
    );
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("heading", { name: "not a heading" })).toBeNull();
  });
});
