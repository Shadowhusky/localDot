import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserUploadChooser,
  BrowserUploadDestination,
  BrowserUploadFiles,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { UPLOAD_BYTES } from "../../../../packages/protocol/src/quarantine.ts";
import type { CdpTransport } from "./pipe.ts";
import { BROWSER_CHOOSER_TIMEOUT_MS, type BrowserFileChooser, BrowserTargets } from "./targets.ts";

interface Command {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
const owners: BrowserTargets[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
});

async function fixture() {
  let receive = (_message: string) => {};
  let hold: ((command: Command) => boolean) | undefined;
  let frameTree: unknown = { frame: { id: "frame", securityOrigin: "https://example.test" } };
  const writes: Command[] = [],
    fatal = vi.fn();
  const info = (id: string, type = "page") => ({
    targetId: id,
    type,
    title: "private",
    url: "https://example.test/?private=never-expose",
    attached: false,
  });
  const event = (method: string, params: unknown, sessionId?: string) =>
    receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const reply = (command: Command, result = {}) =>
    receive(
      JSON.stringify({
        id: command.id,
        result,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      }),
    );
  const attach = (id = "page", session = "owned", parent?: string, type = "page") => {
    event(
      "Target.attachedToTarget",
      { sessionId: session, targetInfo: info(id, type), waitingForDebugger: true },
      parent,
    );
  };
  const transport: CdpTransport = {
    write(message) {
      const command: Command = JSON.parse(message);
      writes.push(command);
      if (hold?.(command)) return;
      queueMicrotask(() => {
        if (command.method === "Target.setDiscoverTargets")
          event("Target.targetCreated", { targetInfo: info("page") });
        if (command.method === "Target.setAutoAttach" && !command.sessionId) attach();
        reply(command, command.method === "Page.getFrameTree" ? { frameTree } : {});
      });
    },
    close() {},
    onMessage(listener) {
      receive = listener;
      return () => {};
    },
    onClose() {
      return () => {};
    },
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/downloads",
    uploadDir: "/uploads",
    onFatal: fatal,
  });
  owners.push(targets);
  await targets.start();
  const tab = targets.tabs()[0]?.id;
  if (!tab) throw new Error("missing fixture tab");
  const open = (
    session = "owned",
    backendNodeId: number | undefined = 17,
    mode = "selectSingle",
    frameId = "frame",
  ) => {
    event(
      "Page.fileChooserOpened",
      { frameId, mode, ...(backendNodeId ? { backendNodeId } : {}) },
      session,
    );
  };
  const claim = () => {
    const choice = targets.fileChooser(tab);
    if (!choice) throw new Error("missing fixture chooser");
    return targets.claimFileChooser(tab, choice.id);
  };
  return {
    targets,
    tab,
    event,
    open,
    claim,
    attach,
    reply,
    writes,
    fatal,
    setTree: (value: unknown) => {
      frameTree = value;
    },
    hold: (next: typeof hold) => {
      hold = next;
    },
  };
}
const scope = () => {
  const abort = new AbortController();
  return { abort, signal: abort.signal, check: () => abort.signal.throwIfAborted() };
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("owned browser file chooser", () => {
  it("offers the receiving document origin without private URL data", async () => {
    const f = await fixture();
    const signal = scope().signal;
    expect(await f.targets.fileChooserOffer(f.tab, signal)).toBeUndefined();
    f.open();
    f.setTree({
      frame: {
        id: "frame",
        securityOrigin: "https://example.test",
        url: "https://example.test/private?token=hidden",
        name: "private-name",
      },
    });
    const offer = await f.targets.fileChooserOffer(f.tab, signal);
    expect(offer).toEqual({
      ...f.targets.fileChooser(f.tab),
      origin: "https://example.test",
      embedded: false,
    });
    expect(Object.isFrozen(offer)).toBe(true);
    const claimed = f.claim();
    expect(await f.targets.claimedFileChooserOffer(claimed, signal)).toEqual(offer);
    expect(await f.targets.fileChooserOffer(f.tab, signal)).toBeUndefined();
  });
  it("identifies a same-process embedded chooser by the exact frame event", async () => {
    const f = await fixture();
    f.setTree({
      frame: { id: "main", securityOrigin: "https://top.test" },
      childFrames: [{ frame: { id: "frame", securityOrigin: "https://receiver.test:8443" } }],
    });
    f.open();
    expect(await f.targets.fileChooserOffer(f.tab, scope().signal)).toMatchObject({
      origin: "https://receiver.test:8443",
      embedded: true,
    });
  });
  it("identifies an out-of-process embedded chooser even at its local tree root", async () => {
    const f = await fixture();
    f.attach("embedded", "child-session", "owned", "iframe");
    await settle();
    f.open("child-session");
    expect(await f.targets.fileChooserOffer(f.tab, scope().signal)).toMatchObject({
      origin: "https://example.test",
      embedded: true,
    });
    expect(f.writes.find((entry) => entry.method === "Page.getFrameTree")?.sessionId).toBe(
      "child-session",
    );
  });
  it.each([
    { frame: { id: "unknown", securityOrigin: "https://top.test" } },
    { frame: { id: "frame" } },
    { frame: { id: "frame", securityOrigin: "://" } },
    { frame: { id: "frame", securityOrigin: "null" } },
    { frame: { id: "frame", securityOrigin: "file://" } },
    { frame: { id: "frame", securityOrigin: "https://example.test/private?secret=value" } },
    {
      frame: { id: "frame", securityOrigin: "https://example.test" },
      childFrames: [{ frame: { id: "frame", securityOrigin: "https://replacement.test" } }],
    },
    {
      frame: { id: "frame", securityOrigin: "https://example.test" },
      childFrames: Array.from({ length: 256 }, (_, i) => ({ frame: { id: `child${i}` } })),
    },
  ])("refuses unknown, opaque, malformed or oversized receiving frame trees %#", async (tree) => {
    const f = await fixture();
    f.open();
    f.setTree(tree);
    await expect(f.targets.fileChooserOffer(f.tab, scope().signal)).rejects.toThrow();
    expect(f.writes.some((entry) => entry.method === "DOM.setFileInputFiles")).toBe(false);
  });
  it.each(["replace", "navigate", "cancel", "claim"])(
    "retires an in-flight offer on %s",
    async (action) => {
      const f = await fixture();
      f.open();
      let sent: Command | undefined;
      f.hold((command) => {
        if (command.method !== "Page.getFrameTree") return false;
        sent = command;
        return true;
      });
      const s = scope();
      const pending = f.targets.fileChooserOffer(f.tab, s.signal);
      const rejected = expect(pending).rejects.toThrow();
      if (action === "replace") f.open();
      if (action === "navigate")
        f.event("Page.frameNavigated", { frame: { id: "frame" } }, "owned");
      if (action === "cancel") s.abort.abort();
      if (action === "claim") f.claim();
      if (!sent) throw new Error("missing frame tree request");
      f.reply(sent, {
        frameTree: { frame: { id: "frame", securityOrigin: "https://example.test" } },
      });
      await rejected;
      expect(f.writes.some((entry) => entry.method === "DOM.setFileInputFiles")).toBe(false);
    },
  );
  it("rejects noncanonical origins and URL credentials at the protocol boundary", () => {
    for (const origin of [
      "https://user:secret@example.test",
      "https://example.test/",
      "https://example.test:443",
      " https://example.test",
      "data:text/html,private",
      "null",
    ])
      expect(BrowserUploadDestination.safeParse({ origin, embedded: false }).success).toBe(false);
  });
  it("offers only an opaque, bounded chooser and fills its private staged file once", async () => {
    const f = await fixture();
    expect(f.targets.fileChooser(f.tab)).toBeUndefined();
    f.open();
    const shown = BrowserUploadChooser.parse(f.targets.fileChooser(f.tab));
    expect(Object.keys(shown).sort()).toEqual(["id", "mode"]);
    expect(shown.mode).toBe("single");
    const chooser = f.claim();
    expect(f.targets.fileChooser(f.tab)).toBeUndefined();
    expect(() => f.targets.claimFileChooser(f.tab, shown.id)).toThrow("stale");
    await f.targets.fillFileChooser(chooser, ["/uploads/verified"], scope());
    expect(f.writes.filter((x) => x.method === "DOM.setFileInputFiles")).toEqual([
      expect.objectContaining({
        sessionId: "owned",
        params: { backendNodeId: 17, files: ["/uploads/verified"] },
      }),
    ]);
    expect(() => f.targets.checkFileChooser(chooser)).toThrow("stale");
    await expect(
      f.targets.fillFileChooser(chooser, ["/uploads/verified"], scope()),
    ).rejects.toThrow("stale");
    // A page may read its File later: success consumes chooser authority but does not
    // invalidate the document handle used by the upload service's retention owner.
    f.targets.check(chooser.document);
    expect(chooser.signal.aborted).toBe(false);
  });
  it("does not permit a direct CDP upload even when the input node is known", async () => {
    const f = await fixture();
    f.open();
    const document = f.targets.documents(f.tab)[0];
    if (!document) throw new Error("missing document");
    await expect(
      f.targets.command(document, "DOM.setFileInputFiles", {
        backendNodeId: 17,
        files: ["/uploads/verified"],
      }),
    ).rejects.toThrow("upload");
    expect(f.writes.some((x) => x.method === "DOM.setFileInputFiles")).toBe(false);
  });
  it("rejects forged handles and wrong/replayed chooser IDs without consuming the real chooser", async () => {
    const f = await fixture();
    f.open();
    expect(() => f.targets.claimFileChooser(f.tab, "forged")).toThrow("stale");
    const chooser = f.claim();
    await expect(
      f.targets.fillFileChooser(
        { ...chooser } as BrowserFileChooser,
        ["/uploads/verified"],
        scope(),
      ),
    ).rejects.toThrow("stale");
    f.targets.checkFileChooser(chooser);
  });
  it("does not offer another tab's chooser", async () => {
    const f = await fixture();
    f.attach("second", "second-owned");
    await settle();
    const second = f.targets.tabs().find((x) => x.id !== f.tab);
    if (!second) throw new Error("missing second tab");
    f.open("second-owned");
    expect(f.targets.fileChooser(f.tab)).toBeUndefined();
    const shown = f.targets.fileChooser(second.id);
    expect(shown?.mode).toBe("single");
    expect(() => f.targets.claimFileChooser(f.tab, shown?.id ?? "")).toThrow("stale");
  });
  it("binds an owned child-frame chooser to its own session within the selected tab", async () => {
    const f = await fixture();
    f.attach("iframe", "child", "owned", "iframe");
    await settle();
    f.open("child", 25);
    const chooser = f.claim();
    expect(chooser.document.frame).toBe(true);
    await f.targets.fillFileChooser(chooser, ["/uploads/verified"], scope());
    expect(f.writes.find((x) => x.method === "DOM.setFileInputFiles")?.sessionId).toBe("child");
  });
  it.each([
    ["DOM.documentUpdated", {}],
    ["Page.frameNavigated", { frame: { id: "frame" } }],
    ["Page.frameAttached", { frameId: "child", parentFrameId: "frame" }],
    ["Page.frameDetached", { frameId: "child", reason: "remove" }],
    ["Page.navigatedWithinDocument", { frameId: "frame", url: "https://example.test/#new" }],
  ])("retires chooser authority on %s", async (method, params) => {
    const f = await fixture();
    f.open();
    const chooser = f.claim();
    f.event(method as string, params, "owned");
    expect(chooser.signal.aborted).toBe(true);
    await expect(
      f.targets.fillFileChooser(chooser, ["/uploads/verified"], scope()),
    ).rejects.toThrow("stale");
    expect(f.writes.some((x) => x.method === "DOM.setFileInputFiles")).toBe(false);
  });
  it("replacement, explicit control retirement, closure and expiry cancel existing claims", async () => {
    const f = await fixture();
    f.open();
    const first = f.claim();
    f.open();
    expect(first.signal.aborted).toBe(true);
    const second = f.claim();
    f.targets.clearFileChooser();
    expect(second.signal.aborted).toBe(true);
    vi.useFakeTimers();
    f.open();
    const third = f.claim();
    await vi.advanceTimersByTimeAsync(BROWSER_CHOOSER_TIMEOUT_MS);
    expect(third.signal.aborted).toBe(true);
    expect(f.targets.fileChooser(f.tab)).toBeUndefined();
    f.open();
    const fourth = f.claim();
    f.targets.close();
    expect(fourth.signal.aborted).toBe(true);
  });
  it("does not accept a non-DOM picker or an unknown session", async () => {
    const f = await fixture();
    f.open();
    const original = f.claim();
    f.event("Page.fileChooserOpened", { frameId: "frame", mode: "selectSingle" }, "owned");
    expect(original.signal.aborted).toBe(true);
    expect(f.targets.fileChooser(f.tab)).toBeUndefined();
    f.open("unowned");
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.writes.some((x) => x.method === "DOM.setFileInputFiles")).toBe(false);
  });
  it.each([
    { files: [] },
    { files: ["/profile/Cookies"] },
    { files: ["/uploads/../profile/Cookies"] },
    { files: ["/uploads/sub/file"] },
    { files: ["/uploads/file", "/uploads/file"] },
    { files: ["/uploads/one", "/uploads/two"] },
  ])("refuses empty, unsafe or single-picker-mismatched file lists %#", async ({ files }) => {
    const f = await fixture();
    f.open();
    const chooser = f.claim();
    await expect(f.targets.fillFileChooser(chooser, files, scope())).rejects.toThrow();
    expect(f.writes.some((x) => x.method === "DOM.setFileInputFiles")).toBe(false);
    expect(() => f.targets.checkFileChooser(chooser)).toThrow("stale");
  });
  it("copies and binds a multiple-picker file list before the native write", async () => {
    const f = await fixture();
    f.open("owned", 17, "selectMultiple");
    const chooser = f.claim();
    const files = ["/uploads/one", "/uploads/two"];
    const done = f.targets.fillFileChooser(chooser, files, scope());
    files[0] = "/uploads/changed";
    await done;
    expect(f.writes.find((x) => x.method === "DOM.setFileInputFiles")?.params.files).toEqual([
      "/uploads/one",
      "/uploads/two",
    ]);
  });
  it("refuses a cancelled or reentrantly retired claim before native dispatch", async () => {
    const f = await fixture();
    f.open();
    const cancelled = f.claim(),
      s = scope();
    s.abort.abort();
    await expect(f.targets.fillFileChooser(cancelled, ["/uploads/verified"], s)).rejects.toThrow();
    f.open();
    const changed = f.claim();
    await expect(
      f.targets.fillFileChooser(changed, ["/uploads/verified"], {
        signal: new AbortController().signal,
        check: () => f.targets.clearFileChooser(),
      }),
    ).rejects.toThrow("stale");
    expect(f.writes.some((x) => x.method === "DOM.setFileInputFiles")).toBe(false);
  });
  it("fences ambiguous in-flight native assignment when ownership is cancelled", async () => {
    const f = await fixture();
    f.open();
    const chooser = f.claim(),
      s = scope();
    f.hold((command) => command.method === "DOM.setFileInputFiles");
    const pending = f.targets.fillFileChooser(chooser, ["/uploads/verified"], s);
    const refused = expect(pending).rejects.toThrow();
    s.abort.abort();
    await refused;
    expect(f.fatal).toHaveBeenCalledOnce();
    expect(f.writes.filter((x) => x.method === "DOM.setFileInputFiles")).toHaveLength(1);
  });
  it("cannot fill the same chooser concurrently while its first native receipt is pending", async () => {
    const f = await fixture();
    f.open();
    const chooser = f.claim();
    let sent: Command | undefined;
    f.hold((command) => {
      if (command.method !== "DOM.setFileInputFiles") return false;
      sent = command;
      return true;
    });
    const first = f.targets.fillFileChooser(chooser, ["/uploads/verified"], scope());
    await expect(f.targets.fillFileChooser(chooser, ["/uploads/other"], scope())).rejects.toThrow(
      "busy",
    );
    expect(chooser.signal.aborted).toBe(false);
    expect(f.writes.filter((x) => x.method === "DOM.setFileInputFiles")).toHaveLength(1);
    if (!sent) throw new Error("missing native write");
    f.reply(sent);
    await first;
  });
  it("bounds upload metadata at ten files and 100MiB total without any browser path fields", () => {
    const file = { name: "report.pdf", bytes: UPLOAD_BYTES, sha256: "a".repeat(64) };
    expect(BrowserUploadFiles.parse([file])).toEqual([file]);
    for (const files of [
      [{ ...file, path: "/browser/profile" }],
      [{ ...file, name: "../report.pdf" }],
      [file, { ...file, bytes: 1 }],
      Array.from({ length: 11 }, () => ({ ...file, bytes: 0 })),
    ])
      expect(BrowserUploadFiles.safeParse(files).success).toBe(false);
  });
});
