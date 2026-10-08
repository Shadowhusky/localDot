import { describe, expect, it, vi } from "vitest";
import { guardCdpCommand } from "./cdp-guard.ts";
import type { CdpTransport } from "./pipe.ts";
import { BrowserTargets } from "./targets.ts";

const guid = "11f6f7b3-2843-4bd8-b905-33b8174c35d4";

function fixture(enabled = true) {
  let receive: (message: string) => void = () => {};
  const writes: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  const downloads = { owns: vi.fn(() => false), begin: vi.fn(), progress: vi.fn() };
  const fatal = vi.fn();
  const transport: CdpTransport = {
    write(message) {
      const command = JSON.parse(message);
      writes.push(command);
      queueMicrotask(() => receive(JSON.stringify({ id: command.id, result: {} })));
    },
    onMessage(callback) {
      receive = callback;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    close: vi.fn(),
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/downloads",
    uploadDir: "/uploads",
    onFatal: fatal,
    ...(enabled ? { downloads } : {}),
  });
  return {
    targets,
    writes,
    downloads,
    fatal,
    event(method: string, params: unknown, sessionId?: string) {
      receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
    },
  };
}

describe("private download CDP boundary", () => {
  it("can deny downloads without granting a path or accepting a broader browser behavior", () => {
    const capabilities = {
      downloadDir: "/downloads",
      uploadDir: "/uploads",
      ownsTarget: () => false,
      ownsSession: () => false,
      ownsWindow: () => false,
      ownsNode: () => false,
      ownsDownload: () => false,
      allowsUpload: () => false,
    };
    expect(
      guardCdpCommand(
        "Browser.setDownloadBehavior",
        { behavior: "deny", eventsEnabled: true },
        capabilities,
      ).params,
    ).toEqual({ behavior: "deny", eventsEnabled: true });
    for (const behavior of ["allow", "default"])
      expect(() =>
        guardCdpCommand(
          "Browser.setDownloadBehavior",
          { behavior, eventsEnabled: true },
          capabilities,
        ),
      ).toThrow();
    expect(() =>
      guardCdpCommand(
        "Browser.setDownloadBehavior",
        { behavior: "deny", eventsEnabled: true, downloadPath: "/profile" },
        capabilities,
      ),
    ).toThrow();
  });

  it("refuses enabling downloads before an owner is installed", async () => {
    const f = fixture(false);
    await expect(f.targets.downloadBehavior(true)).rejects.toThrow("unready");
    expect(f.writes).toHaveLength(0);
    await f.targets.downloadBehavior(false);
    expect(f.writes[0]?.params).toEqual({ behavior: "deny", eventsEnabled: true });
    f.targets.close();
  });

  it("uses only the pinned private directory and cancels only a GUID owned by the download service", async () => {
    const f = fixture();
    await f.targets.downloadBehavior(true);
    expect(f.writes[0]?.params).toEqual({
      behavior: "allowAndName",
      downloadPath: "/downloads",
      eventsEnabled: true,
    });
    await expect(f.targets.cancelDownload(guid)).rejects.toThrow("download");
    expect(f.writes).toHaveLength(1);
    f.downloads.owns.mockImplementation((value?: string) => value === guid);
    await f.targets.cancelDownload(guid);
    expect(f.writes[1]?.params).toEqual({ guid });
    f.targets.close();
  });

  it("routes root download events only to the installed owner", () => {
    const f = fixture();
    const begin = {
      guid,
      frameId: "owned-frame",
      url: "https://files.example.test/private?token=secret",
      suggestedFilename: "report.pdf",
    };
    f.event("Browser.downloadWillBegin", begin);
    f.event("Browser.downloadProgress", { guid, state: "completed", receivedBytes: 42 });
    expect(f.downloads.begin).toHaveBeenCalledWith(begin);
    expect(f.downloads.progress).toHaveBeenCalledWith({
      guid,
      state: "completed",
      receivedBytes: 42,
    });
    f.targets.close();
  });

  it.each(["Browser.downloadWillBegin", "Browser.downloadProgress"])(
    "fences unowned/session-scoped %s events",
    (event) => {
      for (const enabled of [true, false]) {
        const f = fixture(enabled);
        f.event(event, { guid }, enabled ? "foreign-session" : undefined);
        expect(f.fatal).toHaveBeenCalledOnce();
        expect(f.downloads.begin).not.toHaveBeenCalled();
        expect(f.downloads.progress).not.toHaveBeenCalled();
      }
    },
  );
});
