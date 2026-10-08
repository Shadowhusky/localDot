import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type ManualInput, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserControlRequest } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type {
  BrowserUploadOffer,
  BrowserUploadRequest,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import type { DesktopUploadFile } from "../../../../packages/protocol/src/desktop-uploads.ts";
import { BrowserClient, type BrowserScope } from "../browser/client.ts";
import { screenGatewayBinding } from "../browser/gateway-binding.ts";
import { ScreenController, type ScreenControllerDeps } from "../browser/screen-controller.ts";
import { SessionScreens } from "../browser/session-screens.ts";
import { BrowserStreams } from "../browser/streams.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import { ManualInputUncertain, sendManualInput } from "./manual-input.ts";
import { AgentSession } from "./session.ts";
import { toolHarness } from "./testing/harness.ts";
import { dispatchTool } from "./tools/index.ts";
import { Transfers } from "./transfers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0)) await finish();
  vi.restoreAllMocks();
});
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setImmediate(r));
  expect(check()).toBe(true);
}
function fixture(
  productionDownloads = false,
  pendingStop?: (sessionId: string) => Promise<StopOutcome> | undefined,
) {
  const home = mkdtempSync(join(tmpdir(), "session-screens-"));
  const log = new EventLog(home, { nowMicros: () => 1000 });
  const id = log.createSession("screen ownership"),
    cellId = ulid();
  const session = new AgentSession(id, cellId, "screen ownership", log);
  const endpoint: ReadyBrowser = {
    parentCellId: cellId,
    browserCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl: "http://127.0.0.1:5000", token: "t".repeat(43) },
    stream: { baseUrl: "http://127.0.0.1:5001", authorization: "fixture" },
  };
  const tabId = randomUUID();
  const offer: BrowserUploadOffer = {
    id: randomUUID(),
    mode: "multiple",
    origin: "https://receiver.test",
    embedded: true,
  };
  const uploaded: Buffer[] = [];
  const grant = vi.fn(async (_r: BrowserControlRequest) => {});
  let holder: "user" | "agent" = "user",
    revision = 0;
  const client = {
    uploadChooser: vi.fn(
      async (
        _permit: unknown,
        _tab: string,
        scope: BrowserScope,
      ): Promise<BrowserUploadOffer | undefined> => {
        scope.check();
        return { ...offer };
      },
    ),
    upload: vi.fn(async (request: BrowserUploadRequest, source: Readable, scope: BrowserScope) => {
      for await (const chunk of source) {
        scope.check();
        uploaded.push(Buffer.from(chunk));
      }
      scope.check();
      return {
        chooserId: request.chooserId,
        destination: request.destination,
        files: request.files,
      };
    }),
    manual: vi.fn(async (_permit: unknown, input: ManualInput, scope: BrowserScope) => {
      scope.check();
      return {
        kind: "text" as const,
        receipt: {
          done: true as const,
          count: input.kind === "text" ? [...input.text].length : 0,
          firstPressMono: 2,
          armedMono: 1,
          injector: "xtest" as const,
        },
      };
    }),
    read: vi.fn(
      async (_permit: unknown, _tab: string, _request: unknown, _scope: BrowserScope) => ({
        url: "https://example.test/",
        title: "Owned browser page",
        text: "Public page text",
        outline: "heading Public page",
        truncated: false,
      }),
    ),
    clock: vi.fn(async (_permit: unknown, _tabId: string, scope: BrowserScope) => {
      scope.check();
      return { mono: 50 };
    }),
    settle: vi.fn(async () => {
      throw new Error("unused");
    }),
    lookup: vi.fn(async () => {
      throw new Error("unused");
    }),
    health: vi.fn(async (scope: BrowserScope) => {
      scope.check();
      return {
        ...endpoint,
        ready: true as const,
        width: 1280 as const,
        height: 800 as const,
        holder,
      };
    }),
    tabs: vi.fn(async (scope: BrowserScope) => {
      scope.check();
      return { tabs: [{ id: tabId, ready: true }] };
    }),
    control: vi.fn(async (request: BrowserControlRequest, scope: BrowserScope) => {
      scope.check();
      if (request.revision <= revision) throw new Error("stale grant");
      revision = request.revision;
      if (request.holder === "user") holder = "user";
      await grant(request);
      scope.check();
      if (revision !== request.revision) throw new Error("superseded grant");
      holder = request.holder;
      const { owner: _owner, ...receipt } = { owner: undefined, ...request };
      return { ...receipt, reloaded: 0, selectionsCleared: true };
    }),
    close: vi.fn(),
    observe: vi.fn(async () => {
      throw new Error("unused");
    }),
    input: vi.fn(async () => {
      throw new Error("unused");
    }),
    type: vi.fn(async () => {
      throw new Error("unused");
    }),
    navigate: vi.fn(async (_permit: unknown, _tab: string, _url: string, _scope: BrowserScope) => ({
      done: true as const,
    })),
  };
  const deps: ScreenControllerDeps = {
    sessionId: id,
    parentCellId: cellId,
    desktopGeometry: { w: 2560, h: 1600, scale: 2 },
    desktopReady: () => true,
    browser: {
      start: vi.fn(async () => endpoint),
      endpoints: () => endpoint,
      stop: vi.fn(async () => {}),
    },
    client: () => client,
    attachRecording: vi.fn(async () => {}),
    fenceRecording: vi.fn(async () => {}),
    publish: (data) => session.append("screen.switch", data),
    fenceSession: () => session.stop(),
    contain: vi.fn(async () => {}),
  };
  const downloadScopes: { binding: BrowserDownloadBinding; scope: BrowserScope }[] = [];
  const cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-06T00:00:00.000Z",
    stream: NO_STREAM,
  };
  if (productionDownloads) {
    vi.spyOn(BrowserClient.prototype, "health").mockImplementation(client.health);
    vi.spyOn(BrowserClient.prototype, "tabs").mockImplementation(client.tabs);
    vi.spyOn(BrowserClient.prototype, "control").mockImplementation(client.control);
    vi.spyOn(BrowserClient.prototype, "clock").mockImplementation(client.clock);
    vi.spyOn(BrowserClient.prototype, "armDownloads").mockImplementation(async (_binding, scope) =>
      scope.check(),
    );
    vi.spyOn(BrowserClient.prototype, "close").mockImplementation(client.close);
  }
  const streams = new BrowserStreams({
    parents: { get: () => undefined, list: () => [], subscribe: () => () => {} },
    browser: { endpoints: () => endpoint, subscribe: () => () => {} },
    tickets: { revoke: () => {} },
  });
  const physicalStop = vi.fn(async () => {});
  const factory = new SessionScreens({
    cells: {
      get: () => (productionDownloads ? cell : undefined),
      subscribe: () => () => {},
      stop: physicalStop,
    },
    browser: deps.browser,
    streams,
    registry: { for: () => undefined },
    recordings: { attach: async () => {}, fence: async () => {} },
    ...(pendingStop ? { pendingStop } : {}),
    ...(productionDownloads
      ? {
          downloads: {
            collect: async (
              _client: unknown,
              binding: BrowserDownloadBinding,
              scope: BrowserScope,
            ) => {
              scope.check();
              downloadScopes.push({ binding, scope });
              return [];
            },
          },
        }
      : {}),
    now: () => 0,
  });
  if (productionDownloads) factory.install(session, cell);
  else session.attachScreens(new ScreenController(deps));
  const screens = session.screens!;
  cleanup.push(async () => {
    session.stop();
    await session.screensSettled().catch(() => {});
    streams.dispose();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  async function ready() {
    const generation = session.beginBrain();
    await session.prepareScreens(generation);
    return generation;
  }
  async function browser() {
    const generation = await ready();
    const lease = session.admit(generation);
    await session.switchScreen("browser", lease);
    lease.finish();
    return generation;
  }
  return {
    session,
    screens,
    deps,
    log,
    id,
    ready,
    browser,
    grant,
    client,
    factory,
    offer,
    uploaded,
    downloadScopes,
    physicalStop,
    holder: () => holder,
  };
}

describe("session-owned screen authority", () => {
  it("finishes after generation retirement without stopping the desktop or admitting stale downloads", async () => {
    const f = fixture(true),
      generation = await f.browser();
    const retiring = Promise.withResolvers<void>();
    f.grant.mockImplementationOnce(() => retiring.promise);
    f.session.retireBrain(generation);
    const finished = f.session.finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.session.stopped).toBe(false);
    retiring.resolve();
    expect(await finished).toBe(true);
    expect(f.physicalStop).not.toHaveBeenCalled();
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
    expect(f.downloadScopes.some((value) => value.binding.holder === "user")).toBe(true);
    for (const { scope } of f.downloadScopes) expect(() => scope.check()).toThrow();
    expect(() => f.session.beginBrain()).toThrow();
  });

  it("retains normal completion until the browser physically retires", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    const retirement = Promise.withResolvers<void>();
    vi.mocked(f.deps.browser.stop).mockImplementationOnce(() => retirement.promise);
    let settled = false;
    const finished = f.session.finish().then((result) => {
      settled = true;
      return result;
    });
    await until(() => vi.mocked(f.deps.browser.stop).mock.calls.length === 1);
    expect(settled).toBe(false);
    expect(f.session.stopped).toBe(true);
    expect(f.deps.contain).not.toHaveBeenCalled();
    retirement.resolve();
    expect(await finished).toBe(true);
  });

  it("lets Stop contain an in-progress successful cleanup and retains both physical receipts", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    const retirement = Promise.withResolvers<void>(),
      containment = Promise.withResolvers<void>();
    vi.mocked(f.deps.browser.stop).mockImplementationOnce(() => retirement.promise);
    vi.mocked(f.deps.contain).mockImplementationOnce(() => containment.promise);
    let settled = false;
    const finished = f.session.finish().then((result) => {
      settled = true;
      return result;
    });
    await until(() => vi.mocked(f.deps.browser.stop).mock.calls.length === 1);
    f.session.stop();
    expect(f.deps.contain).toHaveBeenCalledOnce();
    retirement.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    containment.resolve();
    expect(await finished).toBe(false);
    await f.session.screensSettled();
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it.each(["recording", "browser"] as const)(
    "contains a failed %s cleanup instead of claiming success",
    async (failure) => {
      const f = fixture(),
        generation = await f.browser();
      f.session.retireBrain(generation);
      await f.session.screensSettled();
      vi.mocked(
        failure === "recording" ? f.deps.fenceRecording : f.deps.browser.stop,
      ).mockRejectedValueOnce(new Error("synthetic cleanup failure"));
      await expect(f.session.finish()).rejects.toThrow();
      expect(f.deps.contain).toHaveBeenCalledOnce();
      expect(f.session.stopped).toBe(true);
    },
  );

  it("honors Stop reentered synchronously by a completion abort observer", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    f.session.abort.signal.addEventListener("abort", () => f.session.stop(), { once: true });
    expect(await f.session.finish()).toBe(false);
    expect(f.deps.contain).toHaveBeenCalledOnce();
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it("refuses successful completion with a live brain or an undrained tool", async () => {
    const f = fixture(),
      generation = await f.ready();
    await expect(f.session.finish()).rejects.toThrow();
    expect(f.session.stopped).toBe(false);
    const lease = f.session.admit(generation);
    f.session.retireBrain(generation);
    await expect(f.session.finish()).rejects.toThrow();
    expect(f.session.stopped).toBe(false);
    expect(f.deps.browser.stop).not.toHaveBeenCalled();
    lease.finish();
    expect(await f.session.finish()).toBe(true);
  });

  it("does not finish a task while the user holds manual control", async () => {
    const f = fixture(),
      generation = await f.browser();
    const taking = f.session
      .takeover("login", "fixture manual control")
      .catch((error: unknown) => error);
    await until(() => f.session.manualControl === "ready");
    f.session.retireBrain(generation);
    await expect(f.session.finish()).rejects.toThrow();
    expect(f.session.stopped).toBe(false);
    expect(f.session.manualControl).toBe("ready");
    f.session.stop();
    await taking;
  });

  it("retains screen cleanup until the existing central Stop confirms containment", async () => {
    const receipt = Promise.withResolvers<StopOutcome>();
    const pending = vi.fn(() => receipt.promise);
    const f = fixture(true, pending);
    const generation = await f.ready();
    f.session.stop();
    let closed = false;
    const closing = f.session.screensSettled().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveBeenCalledWith(f.session.id);
    expect(closed).toBe(false);
    expect(f.physicalStop).not.toHaveBeenCalled();
    expect(() => f.session.admit(generation)).toThrow();
    receipt.resolve({ revoked: true, paused: true, closed: false, stopped: false, errors: [] });
    await closing;
    expect(closed).toBe(true);
    expect(f.physicalStop).not.toHaveBeenCalled();
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it.each(["unconfirmed", "rejected"])(
    "physically stops when central containment is %s",
    async (kind) => {
      const receipt = Promise.withResolvers<StopOutcome>();
      const f = fixture(true, () => receipt.promise);
      await f.ready();
      f.session.stop();
      if (kind === "rejected") receipt.reject(new Error("unconfirmed"));
      else
        receipt.resolve({
          revoked: false,
          paused: true,
          closed: false,
          stopped: false,
          errors: ["keyd"],
        });
      await f.session.screensSettled();
      expect(f.physicalStop).toHaveBeenCalledWith(f.session.cellId);
      expect(f.physicalStop).toHaveBeenCalledOnce();
    },
  );

  it("collects under physical user control between generations and revokes each old download scope", async () => {
    const f = fixture(true),
      old = await f.browser();
    const agentDownload = f.downloadScopes.find((value) => value.binding.holder === "agent");
    expect(agentDownload).toBeDefined();
    f.session.retireBrain(old);
    await f.session.screensSettled();
    expect(f.session.stopped).toBe(false);
    expect(f.session.controlHeld).toBe(false);
    expect(f.holder()).toBe("user");
    expect(() => agentDownload!.scope.check()).toThrow();
    const userDownload = f.downloadScopes.findLast((value) => value.binding.holder === "user");
    expect(userDownload).toBeDefined();
    expect(() => userDownload!.scope.check()).not.toThrow();
    expect(() => f.session.admitManual(ulid(), new AbortController().signal)).toThrow();
    const next = f.session.beginBrain();
    expect(() => f.session.admit(next)).toThrow();
    await f.session.prepareScreens(next);
    expect(() => userDownload!.scope.check()).toThrow();
    const current = f.downloadScopes.findLast((value) => value.binding.holder === "agent");
    expect(current?.binding.holder === "agent" && current.binding.permit.owner.generation).toBe(
      next.id,
    );
    expect(() => current!.scope.check()).not.toThrow();
    f.session.stop();
    await f.session.screensSettled();
    expect(() => current!.scope.check()).toThrow();
  });

  it.each([
    { kind: "key", combo: ["unknownKey"] },
    { kind: "key", combo: ["ctrl", "control", "l"] },
    { kind: "click", at: { x: 1, y: 1 }, button: "left", count: 1, mods: ["alt", "alt"] },
    { kind: "text", text: "\u0001" },
  ] as ManualInput[])(
    "refuses invalid manual input before dispatch without requiring Stop %#",
    async (input) => {
      const f = fixture();
      await f.browser();
      const taking = f.session.takeover("login", "fixture login");
      await until(() => f.session.manualControl === "ready");
      const requestId = f.session.pendingTakeover;
      if (!requestId) throw new Error("Missing takeover");
      await expect(
        sendManualInput(
          f.session,
          { requestId, input },
          new AbortController().signal,
          f.factory.manual.bind(f.factory),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.client.manual).not.toHaveBeenCalled();
      expect(f.session.manualControl).toBe("ready");
      expect(await f.session.handback(requestId, undefined)).toBe(true);
      await taking;
    },
  );
  it("routes manual secrets through the production browser adapter without desktop fallback or journal text", async () => {
    const f = fixture();
    await f.browser();
    const taking = f.session.takeover("login", "fixture login");
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover;
    if (!requestId) throw new Error("Missing takeover");
    await sendManualInput(
      f.session,
      { requestId, input: { kind: "text", text: "private密碼" } },
      new AbortController().signal,
      f.factory.manual.bind(f.factory),
    );
    expect(f.client.manual).toHaveBeenCalledTimes(1);
    expect(f.client.input).not.toHaveBeenCalled();
    expect(f.client.type).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.read(f.id))).not.toContain("private密碼");
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    await taking;
  });

  it("cancels late manual typing and refuses agent handback when completion is uncertain", async () => {
    const f = fixture();
    await f.browser();
    const taking = f.session.takeover("login", "fixture login").catch(() => {});
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover;
    if (!requestId) throw new Error("Missing takeover");
    const release = Promise.withResolvers<void>();
    let active: AbortSignal | undefined;
    f.client.manual.mockImplementationOnce(async (_permit, _input, scope) => {
      active = scope.signal;
      await release.promise;
      return {
        kind: "text",
        receipt: { done: true, count: 1, firstPressMono: 2, armedMono: 1, injector: "xtest" },
      };
    });
    const running = sendManualInput(
      f.session,
      { requestId, input: { kind: "text", text: "密" } },
      new AbortController().signal,
      f.factory.manual.bind(f.factory),
    );
    const failed = expect(running).rejects.toBeInstanceOf(ManualInputUncertain);
    await until(() => !!active);
    const returning = f.session.handback(requestId, undefined);
    await until(() => active?.aborted === true);
    expect(f.holder()).toBe("user");
    release.resolve();
    await failed;
    expect(await returning).toBe(false);
    expect(f.holder()).toBe("user");
    expect(f.session.manualControl).toBe("unconfirmed");
    f.session.stop();
    await taking;
  });
  function tools(f: ReturnType<typeof fixture>) {
    const h = toolHarness();
    cleanup.push(async () => h.close());
    h.tools.bindScreen = (session, lease) =>
      screenGatewayBinding(
        {
          parentCellId: session.cellId,
          screens: f.screens,
          registry: {
            for: () => {
              throw new Error("desktop must not be selected");
            },
          },
          now: () => 1000,
          stream: () => NO_STREAM,
          subscribe: () => () => {},
        },
        lease,
      );
    const callTool = (name: string, input: unknown) =>
      dispatchTool({ tools: h.tools }, f.session, name, "fixture-call", input, (s) => s);
    return { ...h, call: (input: unknown) => callTool("computer", input), callTool };
  }

  function uploads(f: ReturnType<typeof fixture>) {
    const h = tools(f),
      transfers = new Transfers();
    const data = (path: string) =>
      path.endsWith("empty.txt") ? Buffer.alloc(0) : Buffer.from(path);
    const metadata = (path: string): DesktopUploadFile => {
      const canonical = path.startsWith("~/") ? path : `~/${path}`;
      const bytes = data(canonical);
      return {
        path: canonical,
        name: canonical.slice(canonical.lastIndexOf("/") + 1),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        identity: "a".repeat(64),
      };
    };
    const desktop = {
      inspectUpload: vi.fn(async (path: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return metadata(path);
      }),
      readUpload: vi.fn((file: DesktopUploadFile, _signal?: AbortSignal) =>
        Readable.from([data(file.path)]),
      ),
    };
    const source = vi.fn(() => desktop);
    const acquire = vi.spyOn(transfers, "acquire");
    h.tools.uploads = { desktop: source, transfers };
    cleanup.push(async () => {
      transfers.close();
      await transfers.settled();
    });
    const answer = (decision: "approve" | "deny" | "take_control" = "approve") => {
      const card = f.session.pendingApproval;
      if (!card) throw new Error("missing upload approval");
      expect(
        f.session.answerApproval({
          approvalId: card.approvalId,
          generation: card.generation,
          revision: card.revision,
          decision,
        }),
      ).toBe(true);
      return card;
    };
    return { ...h, desktop, source, transfers, acquire, metadata, data, answer };
  }

  it("asks for the exact complete file list and receiving frame before reading or transferring bytes", async () => {
    const f = fixture();
    await f.browser();
    const h = uploads(f);
    const files = ["~/reports/报告.txt", "~/reports/empty.txt", "~/other/报告.txt"];
    const running = h.callTool("browser_upload", { files });
    await until(() => !!f.session.pendingApproval);
    const card = f.session.pendingApproval;
    if (!card) throw new Error("missing upload approval");
    expect(card).toMatchObject({
      title: "Upload files",
      actionClass: "send",
      risk: "high",
      upload: {
        destination: { origin: f.offer.origin, embedded: true },
        files: files.map((path) => {
          const { identity: _id, ...file } = h.metadata(path);
          return file;
        }),
      },
    });
    expect(JSON.stringify(card)).not.toContain('"identity"');
    expect(h.desktop.readUpload).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
    h.answer();
    expect((await running).result.ok).toBe(true);
    expect(f.client.upload).toHaveBeenCalledOnce();
    expect(Buffer.concat(f.uploaded)).toEqual(Buffer.concat(files.map(h.data)));
    expect(h.source).toHaveBeenCalledWith(f.session.cellId);
    expect(h.acquire).toHaveBeenCalledOnce();
    await h.transfers.wait(f.session.cellId);
    expect(f.client.upload.mock.calls[0]?.[0]).toMatchObject({
      chooserId: f.offer.id,
      destination: { origin: f.offer.origin, embedded: true },
    });
  });

  it.each(["deny", "stop", "take_control"] as const)(
    "an upload %s never opens file streams or spends transfer authority",
    async (decision) => {
      const f = fixture();
      await f.browser();
      const h = uploads(f);
      const running = h.callTool("browser_upload", { files: ["~/report.txt"] });
      await until(() => !!f.session.pendingApproval);
      if (decision === "stop") f.session.stop();
      else h.answer(decision);
      if (decision === "take_control") {
        await until(() => f.session.manualControl === "ready");
        expect(f.holder()).toBe("user");
        expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
      }
      expect((await running).result.ok).toBe(false);
      expect(h.desktop.readUpload).not.toHaveBeenCalled();
      expect(h.acquire).not.toHaveBeenCalled();
      expect(f.client.upload).not.toHaveBeenCalled();
    },
  );

  it.each(["identity", "digest", "path", "chooser", "origin", "embedded", "mode"])(
    "refuses approval after the %s changes",
    async (change) => {
      const f = fixture();
      await f.browser();
      const h = uploads(f);
      const running = h.callTool("browser_upload", { files: ["~/report.txt"] });
      await until(() => !!f.session.pendingApproval);
      if (["identity", "digest", "path"].includes(change)) {
        const file = h.metadata("~/report.txt");
        h.desktop.inspectUpload.mockResolvedValue({
          ...file,
          ...(change === "identity"
            ? { identity: "b".repeat(64) }
            : change === "digest"
              ? { sha256: "b".repeat(64) }
              : { path: "~/other/report.txt" }),
        });
      } else
        f.client.uploadChooser.mockResolvedValue({
          ...f.offer,
          ...(change === "chooser"
            ? { id: randomUUID() }
            : change === "origin"
              ? { origin: "https://other.test" }
              : change === "embedded"
                ? { embedded: false }
                : { mode: "single" }),
        });
      h.answer();
      expect((await running).result.ok).toBe(false);
      expect(f.client.upload).not.toHaveBeenCalled();
      expect(h.desktop.readUpload).not.toHaveBeenCalled();
      expect(h.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "single", "duplicate", "oversized", "unknown_input"])(
    "refuses %s uploads before requesting approval",
    async (kind) => {
      const f = fixture();
      await f.browser();
      const h = uploads(f);
      if (kind === "missing") f.client.uploadChooser.mockResolvedValue(undefined);
      if (kind === "single")
        f.client.uploadChooser.mockResolvedValue({ ...f.offer, mode: "single" });
      if (kind === "oversized")
        h.desktop.inspectUpload.mockImplementation(async (path) => ({
          ...h.metadata(path),
          bytes: 100 * 1024 * 1024,
        }));
      const files =
        kind === "duplicate" ? ["report.txt", "~/report.txt"] : ["~/one.txt", "~/two.txt"];
      const result = await h.callTool("browser_upload", {
        files,
        ...(kind === "unknown_input" ? { chooserId: f.offer.id } : {}),
      });
      expect(result.result.ok).toBe(false);
      expect(f.session.pendingApproval).toBeUndefined();
      expect(f.client.upload).not.toHaveBeenCalled();
      expect(h.desktop.readUpload).not.toHaveBeenCalled();
    },
  );

  it("refuses upload on the desktop screen without reading a source", async () => {
    const f = fixture();
    await f.ready();
    const h = uploads(f);
    // Unlike the browser-only fixture binding, the real desktop binding still names the parent.
    h.tools.bindScreen = (_session, lease) =>
      ({
        cellId: f.session.cellId,
        parentCellId: f.session.cellId,
        scale: lease.selection.geometry.scale,
      }) as never;
    expect((await h.callTool("browser_upload", { files: ["~/report.txt"] })).result.ok).toBe(false);
    expect(h.desktop.inspectUpload).not.toHaveBeenCalled();
    expect(f.client.uploadChooser).not.toHaveBeenCalled();
  });

  it.each(["stop", "takeover"])(
    "%s keeps upload leases until the active source physically closes",
    async (kind) => {
      const f = fixture();
      await f.browser();
      const h = uploads(f);
      const closing = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const source = new Readable({
        read() {
          this.push(Buffer.from("a"));
          this._read = () => {};
        },
        destroy(error, done) {
          closing.resolve();
          void release.promise.then(() => done(error));
        },
      });
      h.desktop.readUpload.mockReturnValueOnce(source);
      const running = h.callTool("browser_upload", { files: ["~/one.txt", "~/two.txt"] });
      let taking: Promise<unknown> | undefined;
      try {
        await until(() => !!f.session.pendingApproval);
        h.answer();
        await until(() => h.desktop.readUpload.mock.calls.length === 1);
        if (kind === "stop") f.session.stop();
        else taking = f.session.takeover("other", "interrupt upload");
        await closing.promise;
        let drained = false;
        const waiting = h.transfers.wait(f.session.cellId).then(() => {
          drained = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        if (kind === "takeover") expect(f.session.manualControl).not.toBe("ready");
        release.resolve();
        expect((await running).result.ok).toBe(false);
        await waiting;
        expect(h.desktop.readUpload).toHaveBeenCalledOnce();
        if (kind === "takeover") {
          await until(() => f.session.manualControl === "ready");
          expect(f.holder()).toBe("user");
        }
      } finally {
        release.resolve();
        f.session.stop();
        await running;
        await taking?.catch(() => {}); // Stop cancels the still-pending human handback wait.
      }
    },
  );

  it("routes browser page reading and navigation through the admitted browser with no desktop fallback", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f),
      desktop = vi.spyOn(h.tools, "desktop"),
      observe = vi.spyOn(h.tools.gateway, "observe");
    const read = await h.callTool("browser_read", { max_chars: 1000 });
    expect(read.result.ok).toBe(true);
    expect(read.result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("Public page text") }),
    );
    expect(f.client.read.mock.calls[0]?.[2]).toEqual({ maxChars: 1000 });
    const navigated = await h.callTool("browser_navigate", { url: "https://example.test/article" });
    expect(navigated.result.ok).toBe(true);
    expect(f.client.navigate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      "https://example.test/article",
      expect.any(Object),
    );
    expect(observe.mock.calls.at(-1)?.[0].cellId).not.toBe(f.session.cellId);
    expect(navigated.result.content.some((c) => c.type === "image")).toBe(true);
    expect(desktop).not.toHaveBeenCalled();
  });

  it("dispatches switch_screen through the real controller, clears the old frame and keeps shell/files on the desktop", async () => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    f.session.lastFrameId = ulid();
    const entered = await h.callTool("switch_screen", { screen: "browser" });
    expect(entered.result.ok).toBe(true);
    expect(f.screens.selection.screen).toBe("browser");
    expect(f.screens.selection.cellId).not.toBe(f.session.cellId);
    expect(f.session.lastFrameId).toBeUndefined();
    const desktop = vi.spyOn(h.tools, "desktop");
    await h.callTool("files", { op: "list", path: "." });
    expect(desktop).toHaveBeenCalledWith(f.session.cellId);
    expect((await h.callTool("browser_read", {})).result.ok).toBe(true);
    expect(f.client.read).toHaveBeenCalled();
    const oldRevision = f.screens.selection.revision;
    expect((await h.callTool("switch_screen", { screen: "desktop" })).result.ok).toBe(true);
    expect(f.screens.selection).toMatchObject({
      screen: "desktop",
      cellId: f.session.cellId,
      revision: oldRevision + 1,
    });
    expect(f.holder()).toBe("user");
  });

  it("cannot switch away from a user-owned login or grant after Stop interrupts a switch", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    const taking = f.session.takeover("login", "manual login").catch(() => {});
    await until(() => f.session.manualControl === "ready");
    const selected = f.screens.selection;
    expect((await h.callTool("switch_screen", { screen: "desktop" })).result.ok).toBe(false);
    expect(f.screens.selection).toBe(selected);
    expect(f.holder()).toBe("user");
    f.session.stop();
    await taking;
    expect((await h.callTool("switch_screen", { screen: "browser" })).result.ok).toBe(false);
  });

  it("discards page text that returns after takeover and drains the browser-reading tool", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f),
      wait = Promise.withResolvers<Awaited<ReturnType<typeof f.client.read>>>();
    f.client.read.mockImplementationOnce(() => wait.promise);
    const reading = h.callTool("browser_read", {});
    await until(() => f.client.read.mock.calls.length === 1);
    const taking = f.session.takeover("other", "interrupt read");
    wait.resolve({
      url: "https://example.test/",
      title: "late private title",
      text: "late-private-canary",
      outline: "",
      truncated: false,
    });
    const result = await reading;
    expect(result.result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("late-private");
    await until(() => f.session.manualControl === "ready");
    expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
    await taking;
  });

  it("pins computer screenshots, cursor coordinates and actions to the selected browser, then drains their lease", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f),
      observe = vi.spyOn(h.tools.gateway, "observe"),
      bind = vi.spyOn(h.tools, "bindScreen");
    expect((await h.call({ action: "screenshot" })).result.ok).toBe(true);
    const owner = observe.mock.calls[0]?.[0];
    expect(owner?.cellId).not.toBe(f.session.cellId);
    expect(owner?.screen?.parentCellId).toBe(f.session.cellId);
    expect(() => bind.mock.calls[0]?.[1].check()).toThrow();
    const cursor = vi.spyOn(h.tools.gateway, "cursorOf").mockReturnValue({ x: 800, y: 600 });
    expect((await h.call({ action: "cursor_position" })).result.content).toContainEqual({
      type: "text",
      text: "The cursor is at (400, 300).",
    });
    expect(cursor).toHaveBeenCalledWith(owner?.cellId);
    expect((await h.call({ action: "key", keys: ["ArrowRight"] })).result.ok).toBe(true);
    expect(h.actions.at(-1)?.ctx.cellId).toBe(owner?.cellId);
    expect(h.actions.at(-1)?.ctx.source).toBe("agent");
  });

  it("refuses to hold keys on the browser screen before asking for or starting any input", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    const held = await h.call({ action: "hold_key", keys: ["shift"], ms: 1000 });
    expect(held.result).toEqual({
      ok: false,
      content: [{ type: "text", text: "Holding keys is not available on the browser screen." }],
    });
    expect(h.actions).toEqual([]);
  });

  it("fails closed when a screen-enabled session has no gateway binding", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f),
      observe = vi.spyOn(h.tools.gateway, "observe");
    h.tools.bindScreen = undefined;
    expect((await h.call({ action: "screenshot" })).result.ok).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    const taking = f.session.takeover("other", "after refused binding");
    await until(() => f.session.manualControl === "ready");
    expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
    await taking;
  });

  it.each(["secret", "approval"] as const)(
    "drains the initiating screen lease for %s handoff and never replays input",
    async (kind) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      h.tools.gateway.run = async (ctx, action) => {
        await ctx.authorizeAgent?.({
          action,
          identity: {
            point: { x: 10, y: 20 },
            window: null,
            target: {
              source: "ax",
              point: { x: 10, y: 20 },
              role: kind === "secret" ? "password" : "button",
              name: kind === "secret" ? "Password" : "Delete account",
              ...(kind === "secret" ? { secret: true } : {}),
            },
          },
          revalidate: async () => true,
        });
        throw new Error("a handed-back tool must not return to native input");
      };
      const running = h.call({ action: "click", point: { x: 10, y: 20 } });
      if (kind === "approval") {
        await until(() => !!f.session.pendingApproval);
        const card = f.session.pendingApproval!;
        expect(
          f.session.answerApproval({
            approvalId: card.approvalId,
            generation: card.generation,
            revision: card.revision,
            decision: "take_control",
          }),
        ).toBe(true);
      }
      await until(() => f.session.manualControl === "ready");
      expect(f.holder()).toBe("user");
      expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
      expect((await running).result.ok).toBe(false);
      expect(f.holder()).toBe("agent");
    },
  );

  it("invalidates the screenshot basis when preparing, switching screens, and returning control", async () => {
    const f = fixture();
    f.session.lastFrameId = ulid();
    const generation = await f.ready();
    expect(f.session.lastFrameId).toBeUndefined();
    f.session.lastFrameId = ulid();
    const lease = f.session.admit(generation);
    await f.session.switchScreen("browser", lease);
    lease.finish();
    expect(f.session.lastFrameId).toBeUndefined();
    f.session.lastFrameId = ulid();
    const taking = f.session.takeover("login", "synthetic login");
    await until(() => f.session.manualControl === "ready");
    expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
    await taking;
    expect(f.session.lastFrameId).toBeUndefined();
  });

  it("keeps tool admission closed until the initial recording attachment is confirmed", async () => {
    const f = fixture(),
      barrier = Promise.withResolvers<void>();
    vi.mocked(f.deps.attachRecording).mockImplementationOnce(() => barrier.promise);
    const generation = f.session.beginBrain();
    const preparing = f.session.prepareScreens(generation);
    await until(() => vi.mocked(f.deps.attachRecording).mock.calls.length === 1);
    expect(() => f.session.admit(generation)).toThrow();
    expect(f.log.read(f.id).filter((e) => e.type === "screen.switch")).toHaveLength(0);
    barrier.resolve();
    await preparing;
    const lease = f.session.admit(generation),
      screen = f.session.screenLease(lease);
    expect(screen.selection.screen).toBe("desktop");
    screen.finish();
    lease.finish();
  });

  it("drains physical screen work and tool work before accepting manual input", async () => {
    const f = fixture(),
      generation = await f.browser();
    const lease = f.session.admit(generation),
      screen = f.session.screenLease(lease);
    const taking = f.session.takeover("login", "synthetic login");
    expect(f.session.manualControl).toBe("waiting");
    expect(screen.signal.aborted).toBe(true);
    expect(() => f.session.admit(generation)).toThrow();
    lease.finish();
    await new Promise((r) => setImmediate(r));
    expect(f.session.manualControl).toBe("waiting");
    screen.finish();
    await until(() => f.session.manualControl === "ready");
    expect(f.holder()).toBe("user");
    const requestId = f.session.pendingTakeover!;
    expect(f.session.endTakeover(requestId, undefined)).toBe(false);
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    expect(await taking).toEqual({ by: "user" });
    expect(f.holder()).toBe("agent");
  });

  it("handback drains manual input and waits for the new browser grant", async () => {
    const f = fixture(),
      generation = await f.browser();
    const taking = f.session.takeover("login", "synthetic login");
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover!,
      manual = f.session.admitManual(requestId, new AbortController().signal);
    const barrier = Promise.withResolvers<void>();
    f.grant.mockImplementation((request) =>
      request.holder === "agent" ? barrier.promise : Promise.resolve(),
    );
    const returning = f.session.handback(requestId, "ready");
    expect(manual.signal.aborted).toBe(true);
    expect(f.holder()).toBe("user");
    manual.finish();
    await until(() => f.grant.mock.calls.at(-1)?.[0].holder === "agent");
    expect(f.session.manualControl).toBe("returning");
    expect(() => f.session.admit(generation)).toThrow();
    barrier.resolve();
    expect(await returning).toBe(true);
    await taking;
    const lease = f.session.admit(generation),
      screen = f.session.screenLease(lease);
    expect(f.screens.browserAccess(screen).permit.owner.generation).toBe(generation.id);
    screen.finish();
    lease.finish();
  });

  it("a retired brain cannot regain control on handback; its replacement gets a new grant", async () => {
    const f = fixture(),
      old = await f.browser();
    const taking = f.session.takeover("login", "synthetic login").catch(() => {});
    await until(() => f.session.manualControl === "ready");
    f.session.retireBrain(old);
    expect(f.session.generation).toBeUndefined();
    expect(await f.session.handback(f.session.pendingTakeover!, undefined)).toBe(true);
    await taking;
    expect(f.holder()).toBe("user");
    const next = f.session.beginBrain();
    expect(() => f.session.admit(next)).toThrow();
    await f.session.prepareScreens(next);
    const lease = f.session.admit(next),
      screen = f.session.screenLease(lease);
    expect(f.screens.browserAccess(screen).permit.owner.generation).toBe(next.id);
    expect(next.id).toBeGreaterThan(old.id);
    expect(() => f.session.admit(old)).toThrow();
    screen.finish();
    lease.finish();
  });

  it("terminal Stop fences a delayed attachment and contains without reentrant deadlock", async () => {
    const f = fixture(),
      barrier = Promise.withResolvers<void>();
    vi.mocked(f.deps.attachRecording).mockImplementationOnce(() => barrier.promise);
    const generation = f.session.beginBrain();
    const preparing = f.session.prepareScreens(generation).catch(() => "stopped");
    await until(() => vi.mocked(f.deps.attachRecording).mock.calls.length === 1);
    f.session.stop();
    expect(f.session.stopped).toBe(true);
    expect(generation.signal.aborted).toBe(true);
    barrier.resolve();
    expect(await preparing).toBe("stopped");
    await f.session.screensSettled();
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    expect(f.log.read(f.id).filter((e) => e.type === "screen.switch")).toHaveLength(0);
  });

  it("rejects a forged tool lease even when it references the current generation", async () => {
    const f = fixture(),
      generation = await f.ready();
    const fake = { generation, signal: generation.signal, check: () => {}, finish: () => {} };
    expect(() => f.session.screenLease(fake)).toThrow();
    await expect(f.session.switchScreen("browser", fake)).rejects.toThrow();
    expect(f.deps.browser.start).not.toHaveBeenCalled();
  });

  it("does not let a failed initial attachment open tool admission", async () => {
    const f = fixture();
    vi.mocked(f.deps.attachRecording).mockRejectedValueOnce(new Error("not attached"));
    const generation = f.session.beginBrain();
    await expect(f.session.prepareScreens(generation)).rejects.toThrow();
    expect(f.session.stopped).toBe(true);
    expect(() => f.session.admit(generation)).toThrow();
  });
});
