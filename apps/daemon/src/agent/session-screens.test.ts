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
import { BrowserClient, BrowserClientError, type BrowserScope } from "../browser/client.ts";
import { screenGatewayBinding } from "../browser/gateway-binding.ts";
import { ScreenController, type ScreenControllerDeps } from "../browser/screen-controller.ts";
import { SessionScreens } from "../browser/session-screens.ts";
import { BrowserStreams } from "../browser/streams.ts";
import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import type { NativeScreenBinding } from "../gateway/gateway.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import { VaultLockedError } from "../keyd/client.ts";
import { ManualInputUncertain, sendManualInput } from "./manual-input.ts";
import { redactor } from "./redact.ts";
import { AgentSession, ControlHeldError } from "./session.ts";
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
    secret: vi.fn(async (_p: unknown, _t: string, request: { text?: string }) => ({
      filled: request.text !== undefined,
      rememberable: true,
    })),
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
    navigate: vi.fn(
      async (
        _permit: unknown,
        _tab: string,
        _url: string,
        _scope: BrowserScope,
      ): Promise<{ done: true; download?: true }> => ({
        done: true as const,
      }),
    ),
  };
  const deps: ScreenControllerDeps = {
    sessionId: id,
    parentCellId: cellId,
    desktopGeometry: { w: 2560, h: 1600, scale: 2 },
    desktopReady: () => true,
    browser: {
      start: vi.fn(async () => endpoint),
      endpoints: () => endpoint,
      get: vi.fn<BrowserOrchestrator["get"]>(() => undefined),
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
  it("reuses only the account name on a username-first sign-in page", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    f.client.lookup.mockImplementation((async () => ({
      target: {
        point: { x: 400, y: 300 },
        source: "dom",
        role: "textbox",
        name: "Email address",
        url: "https://identity.example.net/start",
        editable: true,
      },
      window: 0,
      ms: 1,
    })) as never);
    h.tools.logins = {
      login: vi.fn(async () => ({
        username: "fixture@example.net",
        password: "private-staged-canary",
      })),
      saveLogin: vi.fn(),
    };
    const reply = await h.callTool("ask_user", {
      purpose: "sign_in",
      question: "Account?",
      fields: [{ id: "account", kind: "email", label: "Email" }],
    });
    expect(reply.result.ok).toBe(true);
    expect(JSON.stringify(reply)).toContain("fixture@example.net");
    expect(JSON.stringify([reply, f.log.read(f.id)])).not.toContain("private-staged-canary");
    expect(h.tools.logins.login).toHaveBeenCalledWith("https://identity.example.net");
    expect(f.session.pendingAsk).toBeUndefined();
    expect(f.client.secret).not.toHaveBeenCalled();
  });

  it.each(["missing-account", "unavailable-store", "saved-login"] as const)(
    "uses generic saved credential handling: %s",
    async (mode) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      f.client.lookup.mockImplementation((async () => ({
        target: {
          point: { x: 400, y: 300 },
          source: "dom",
          role: "textbox",
          name: "Password",
          url: "https://identity.example.org/signin",
          secret: true,
        },
        window: 0,
        ms: 1,
      })) as never);
      h.tools.logins = {
        login: vi.fn(async () => {
          if (mode === "unavailable-store") throw new Error("private-store-error");
          return {
            username: mode === "missing-account" ? "" : "fixture-user",
            password: "saved-private-canary",
          };
        }),
        saveLogin: vi.fn(async () => {}),
      };
      const pending = h.callTool("ask_user", {
        question: "Sign in",
        fields: [
          { id: "username", kind: "text", label: "Account" },
          { id: "password", kind: "secret", label: "Password", target: [400, 300] },
        ],
      });
      if (mode === "missing-account") {
        await until(() => !!f.session.pendingAsk);
        const ask = f.log.read(f.id).findLast((e) => e.type === "ask.request");
        expect(ask?.type === "ask.request" && ask.data.fields?.map((field) => field.kind)).toEqual([
          "text",
        ]);
        f.session.answerFields(
          f.session.pendingAsk ?? "",
          { username: "fixture-user" },
          (text) => text,
        );
      }
      const reply = await pending;
      expect(reply.result.ok).toBe(mode !== "unavailable-store");
      const asks = f.log.read(f.id).filter((e) => e.type === "ask.request");
      expect(asks).toHaveLength(mode === "missing-account" ? 1 : 0);
      expect(JSON.stringify([reply, f.log.read(f.id)])).not.toMatch(
        /saved-private-canary|private-store-error/,
      );
      if (mode === "unavailable-store")
        expect(JSON.stringify(reply)).toContain("temporarily unavailable");
      else expect(JSON.stringify(reply)).toContain("Submission was not confirmed");
      // A saved password filled for the task is masked in whatever the task shows afterwards.
      expect(redactor([], f.session)("saved-private-canary")).toBe(
        mode === "unavailable-store" ? "saved-private-canary" : "[redacted]",
      );
    },
  );

  it("points dot at the Unlock card when saved sign-ins are locked, asking for nothing", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    f.client.lookup.mockImplementation((async () => ({
      target: {
        point: { x: 400, y: 300 },
        source: "dom",
        role: "textbox",
        name: "Password",
        url: "https://identity.example.org/signin",
        secret: true,
      },
      window: 0,
      ms: 1,
    })) as never);
    h.tools.logins = {
      login: vi.fn(async () => {
        throw new VaultLockedError();
      }),
      saveLogin: vi.fn(async () => {}),
    };
    const reply = await h.callTool("ask_user", {
      question: "Sign in",
      fields: [
        { id: "username", kind: "text", label: "Account" },
        { id: "password", kind: "secret", label: "Password", target: [400, 300] },
      ],
    });
    expect(reply.result.ok).toBe(false);
    expect(JSON.stringify(reply)).toContain("Unlock card");
    expect(f.log.read(f.id).filter((e) => e.type === "ask.request")).toHaveLength(0);
    expect(f.log.read(f.id).filter((e) => e.type === "keys.lock")).toHaveLength(1);
    expect(f.session.keysLocked).toBe(true);
  });

  it.each([false, true])(
    "cancels the task without shutting down its computer (user control: %s)",
    async (held) => {
      const f = fixture(true);
      await f.browser();
      if (held) {
        f.session.takeControl();
        await until(() => f.session.status === "waiting_user");
      }
      f.session.cancel();
      expect(f.session.stopped).toBe(true);
      await f.session.screensSettled();
      expect(f.holder()).toBe("user");
      expect(f.physicalStop).not.toHaveBeenCalled();
      expect(f.deps.browser.stop).not.toHaveBeenCalled();
      expect(f.deps.contain).not.toHaveBeenCalled();
      expect(() => f.session.beginBrain()).toThrow();
    },
  );

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
    expect(f.deps.browser.stop).not.toHaveBeenCalled();
    expect(f.holder()).toBe("user");
    expect(f.downloadScopes.some((value) => value.binding.holder === "user")).toBe(true);
    for (const { scope } of f.downloadScopes) expect(() => scope.check()).toThrow();
    expect(() => f.session.beginBrain()).toThrow();
  });

  it("retains normal completion until the browser confirms control went back to the user", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    const released = Promise.withResolvers<void>();
    const controls = f.grant.mock.calls.length;
    f.grant.mockImplementationOnce(() => released.promise);
    let settled = false;
    const finished = f.session.finish().then((result) => {
      settled = true;
      return result;
    });
    await until(() => f.grant.mock.calls.length === controls + 1);
    expect(f.grant.mock.calls.at(-1)?.[0].holder).toBe("user");
    expect(settled).toBe(false);
    expect(f.session.stopped).toBe(true);
    expect(f.deps.contain).not.toHaveBeenCalled();
    released.resolve();
    expect(await finished).toBe(true);
    expect(f.deps.browser.stop).not.toHaveBeenCalled();
  });

  it("stops the browser when a finished task cannot confirm handing it back", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    f.grant.mockRejectedValueOnce(new Error("synthetic control failure"));
    expect(await f.session.finish()).toBe(true);
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it("keeps the computer running when the web browser a task used no longer answers as it finishes", async () => {
    const f = fixture(true),
      generation = await f.browser();
    const lease = f.session.admit(generation);
    await f.session.switchScreen("desktop", lease);
    lease.finish();
    f.client.control.mockRejectedValue(new Error("browser stopped answering"));
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    expect(f.session.stopped).toBe(false);
    expect(await f.session.finish()).toBe(true);
    expect(f.deps.browser.stop).toHaveBeenCalledWith(f.session.cellId);
    expect(f.physicalStop).not.toHaveBeenCalled();
  });

  it("still stops the computer when a finished task's web browser can neither hand back nor stop", async () => {
    const f = fixture(true),
      generation = await f.browser();
    f.client.control.mockRejectedValue(new Error("browser stopped answering"));
    vi.mocked(f.deps.browser.stop).mockRejectedValue(new Error("shutdown unconfirmed"));
    f.session.retireBrain(generation);
    await f.session.screensSettled().catch(() => {});
    expect(f.session.stopped).toBe(true);
    expect(f.physicalStop).toHaveBeenCalledWith(f.session.cellId);
  });

  it("lets Stop contain an in-progress successful cleanup and retains both physical receipts", async () => {
    const f = fixture(),
      generation = await f.browser();
    f.session.retireBrain(generation);
    await f.session.screensSettled();
    const retirement = Promise.withResolvers<void>(),
      containment = Promise.withResolvers<void>();
    const controls = f.grant.mock.calls.length;
    f.grant.mockImplementationOnce(() => retirement.promise);
    vi.mocked(f.deps.contain).mockImplementationOnce(() => containment.promise);
    let settled = false;
    const finished = f.session.finish().then((result) => {
      settled = true;
      return result;
    });
    await until(() => f.grant.mock.calls.length === controls + 1);
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
      vi.mocked(failure === "recording" ? f.deps.fenceRecording : f.grant).mockRejectedValueOnce(
        new Error("synthetic cleanup failure"),
      );
      if (failure === "browser")
        vi.mocked(f.deps.browser.stop).mockRejectedValueOnce(new Error("synthetic stop failure"));
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

  it("recovers an uncertain browser input with a fresh user grant, without replaying private text", async () => {
    const f = fixture();
    await f.browser();
    const taking = f.session.takeover("login", "fixture login");
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover!;
    const confirmed = Promise.withResolvers<void>();
    f.grant.mockImplementationOnce(async () => confirmed.promise);
    f.client.manual.mockRejectedValueOnce(new BrowserClientError("unavailable"));
    const send = () =>
      sendManualInput(
        f.session,
        { requestId, input: { kind: "text", text: "private密碼" } },
        new AbortController().signal,
        f.factory.manual.bind(f.factory),
      );
    await expect(send()).rejects.toBeInstanceOf(ManualInputUncertain);
    expect(f.session.manualControl).toBe("unconfirmed");
    await expect(send()).rejects.toBeInstanceOf(ControlHeldError);
    expect(f.holder()).toBe("user");
    expect(f.client.manual).toHaveBeenCalledOnce();
    confirmed.resolve();
    await until(() => f.session.manualControl === "ready");
    expect(f.grant.mock.calls.at(-1)?.[0].holder).toBe("user");
    expect(f.client.read).not.toHaveBeenCalled();
    expect(f.client.navigate).not.toHaveBeenCalled();
    expect(f.client.manual).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.log.read(f.id))).not.toContain("private密碼");
    await send();
    expect(f.client.manual).toHaveBeenCalledTimes(2);
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    await taking;
  });

  it("retries browser delivery recovery after a failed acknowledgement", async () => {
    const f = fixture();
    await f.browser();
    const taking = f.session.takeover("login", "fixture login");
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover!;
    f.client.manual.mockRejectedValueOnce(new BrowserClientError("unavailable"));
    f.grant.mockRejectedValueOnce(new BrowserClientError("unavailable"));
    await expect(
      sendManualInput(
        f.session,
        { requestId, input: { kind: "text", text: "private" } },
        new AbortController().signal,
        f.factory.manual.bind(f.factory),
      ),
    ).rejects.toBeInstanceOf(ManualInputUncertain);
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    expect(f.holder()).toBe("user");
    expect(f.client.manual).toHaveBeenCalledOnce();
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    await taking;
  });

  it("allows another hand-back attempt after the screen rejects the first one", async () => {
    const f = fixture();
    await f.browser();
    const taking = f.session.takeover("login", "fixture login");
    await until(() => f.session.manualControl === "ready");
    const requestId = f.session.pendingTakeover!;
    vi.spyOn(f.screens, "handback").mockRejectedValueOnce(new Error("temporary failure"));
    expect(await f.session.handback(requestId, undefined)).toBe(false);
    expect(f.session.manualControl).toBe("ready");
    expect(f.holder()).toBe("user");
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    await taking;
  });

  it("lets typing already on its way land before the browser goes back to dot", async () => {
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
    const landed = expect(running).rejects.toBeInstanceOf(ControlHeldError);
    await until(() => !!active);
    const returning = f.session.handback(requestId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(active?.aborted).toBe(false);
    expect(f.holder()).toBe("user");
    expect(f.session.manualControl).toBe("returning");
    release.resolve();
    await landed;
    expect(await returning).toBe(true);
    expect(f.holder()).toBe("agent");
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

  function bindDesktop(h: ReturnType<typeof tools>) {
    const browserBinding = h.tools.bindScreen;
    h.tools.bindScreen = (session, lease) =>
      lease.selection.screen === "desktop"
        ? {
            cellId: session.cellId,
            parentCellId: session.cellId,
            scale: lease.selection.geometry.scale,
            device: {} as NativeScreenBinding["device"],
            signal: lease.signal,
            check: () => lease.check(),
            stream: () => NO_STREAM,
            subscribe: () => () => {},
          }
        : (browserBinding?.(session, lease) as NativeScreenBinding);
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
      actionClass: "upload",
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

  it("reports a download without claiming its URL became a page", async () => {
    const f = fixture();
    await f.browser();
    f.client.navigate.mockResolvedValueOnce({ done: true, download: true });
    const h = tools(f);
    const result = await h.callTool("browser_navigate", { url: "https://example.test/source.zip" });
    expect(result.result.ok).toBe(true);
    const text = result.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    expect(text).toContain("Download started");
    expect(text).toContain("Downloads");
    expect(text).not.toContain("Opened:");
    expect(f.client.read).not.toHaveBeenCalled();
    expect(result.result.recovery?.kind).toBe("download_pending");
  });

  it("tells dot a download reaches ~/Downloads by itself in Full access", async () => {
    const f = fixture();
    await f.browser();
    f.session.permissionMode = () => "full";
    f.client.navigate.mockResolvedValueOnce({ done: true, download: true });
    const h = tools(f);
    const result = await h.callTool("browser_navigate", { url: "https://example.test/source.zip" });
    const text = result.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    expect(text).toContain("reaches ~/Downloads on the computer by itself");
    expect(text).not.toContain("before they reach the computer");
  });

  it.each(["observe", "frame"] as const)(
    "keeps an acknowledged download when its follow-up %s is unavailable",
    async (failure) => {
      const f = fixture();
      await f.browser();
      f.client.navigate.mockResolvedValueOnce({ done: true, download: true });
      const h = tools(f);
      if (failure === "observe")
        vi.spyOn(h.tools.gateway, "observe").mockRejectedValueOnce(
          new BrowserClientError("protected_input"),
        );
      else vi.spyOn(h.tools.png, "png").mockRejectedValueOnce(new Error("frame unavailable"));
      const result = await h.callTool("browser_navigate", {
        url: "https://example.test/source.zip",
      });
      expect(result.result).toMatchObject({
        ok: true,
        recovery: { kind: "download_pending", retry: "never" },
      });
      expect(result.result.content.some((c) => c.type === "image")).toBe(false);
      expect(result.result.content).toContainEqual({
        type: "text",
        text: expect.stringContaining("Download started"),
      });
      expect(f.client.navigate).toHaveBeenCalledOnce();
    },
  );

  it("distinguishes a healthy blank starting tab from a browser failure and can open the app", async () => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    Object.assign(f.deps.browser, { status: async () => ({ state: "ready" }) });
    const context = await h.callTool("work_context", { goal: "app" });
    const inventory = context.result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join(" ");
    expect(inventory).toContain('"available":true');
    expect(inventory).toContain('"state":"not_open"');
    expect(inventory).toContain('"health":{"state":"ready"}');
    expect(inventory).toContain('"page":"not_inspected"');
    await h.callTool("switch_screen", { screen: "browser" });
    f.client.read.mockResolvedValueOnce({
      url: "about:blank",
      title: "",
      text: "",
      outline: "",
      truncated: false,
    });
    const read = await h.callTool("browser_read", {});
    expect(read.result.ok).toBe(true);
    expect(read.result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("blank starting page, not a browser failure"),
    });
    expect(read.result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("browser_navigate"),
    });
    expect(f.client.navigate).not.toHaveBeenCalled();
    expect(f.session.workProgress.snapshot()).toContainEqual(
      expect.objectContaining({
        tool: "browser_read",
        ok: true,
      }),
    );
    const opened = await h.callTool("browser_navigate", { url: "https://example.test/" });
    expect(opened.result.ok).toBe(true);
    expect(f.client.navigate).toHaveBeenCalledOnce();
    expect(opened.result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Opened: Owned browser page"),
      }),
    );
  });

  it("does not misclassify a loaded page that describes itself as blank", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    f.client.read.mockResolvedValueOnce({
      url: "https://example.test/",
      title: "about:blank",
      text: "browser unavailable",
      outline: "",
      truncated: false,
    });
    const read = await h.callTool("browser_read", {});
    expect(read.result.ok).toBe(true);
    expect(read.result.content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(/^<untrusted/),
    });
  });

  it("reports unverified navigation when the page is changing, without replaying it", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    f.client.read.mockRejectedValueOnce(new BrowserClientError("refused"));
    const navigated = await h.callTool("browser_navigate", { url: "https://example.test/game" });
    expect(navigated.result).toMatchObject({
      ok: false,
      recovery: { kind: "stale", retry: "after_observation" },
    });
    expect(navigated.result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Navigation was acknowledged"),
    });
    expect(navigated.result.content.some((c) => c.type === "image")).toBe(true);
    expect(f.client.navigate).toHaveBeenCalledOnce();
    expect((await h.callTool("browser_read", {})).result.ok).toBe(true);
    expect(f.client.navigate).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "protected_input", "stale", "aborted", "reply"] as const)(
    "preserves a %s failure instead of claiming the navigation loaded",
    async (code) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      const observe = vi.spyOn(h.tools.gateway, "observe");
      f.client.read.mockRejectedValueOnce(new BrowserClientError(code));
      const navigated = await h.callTool("browser_navigate", { url: "https://example.test/game" });
      expect(navigated.result.ok).toBe(false);
      expect(navigated.result.content[0]).toEqual({
        type: "text",
        text: expect.stringContaining(new BrowserClientError(code).message),
      });
      expect(observe).not.toHaveBeenCalled();
      expect(f.client.navigate).toHaveBeenCalledOnce();
    },
  );

  it.each(["about:blank", "chrome-error://chromewebdata/"])(
    "does not report %s as the loaded app after navigation acknowledgement",
    async (url) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      f.client.read.mockResolvedValueOnce({
        url,
        title: "",
        text: "",
        outline: "",
        truncated: false,
      });
      const navigated = await h.callTool("browser_navigate", { url: "https://example.test/game" });
      expect(navigated.result.ok).toBe(false);
      const output = navigated.result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join(" ");
      expect(output).not.toContain("Opened:");
      expect(output).toContain("Browser status: reachable");
      expect(f.client.navigate).toHaveBeenCalledOnce();
    },
  );

  it("types a secret answer into the web browser's own field, and nothing once the screen changed", async () => {
    const secret = "s3cret phrase for the mail";
    const field = {
      point: { x: 400, y: 300 },
      bbox: { x: 320, y: 290, w: 160, h: 20 },
      source: "dom" as const,
      role: "textbox",
      name: "Password",
      url: "https://mail.example.test/login",
      secret: true,
    };
    const f = fixture();
    await f.browser();
    const h = tools(f);
    f.client.lookup.mockImplementation((async () => ({
      target: field,
      window: 0,
      ms: 1,
    })) as never);
    f.client.input.mockImplementation((async () => ({
      pressMono: 1,
      presses: [1],
      injector: "xtest",
      armedMono: 0,
    })) as never);
    f.client.type.mockImplementation((async (
      _p: unknown,
      _t: unknown,
      request: { text: string },
    ) => ({
      done: true,
      count: [...request.text].length,
      firstPressMono: 1,
      injector: "xtest",
      armedMono: 0,
    })) as never);
    const login = {
      question: "Sign in to your mail",
      fields: [{ id: "password", kind: "secret", label: "Password", target: [400, 300] }],
    };
    const asking = h.callTool("ask_user", login);
    await until(() => f.session.pendingAsk !== undefined);
    const request = f.log.read(f.id).find((e) => e.type === "ask.request");
    expect(request?.data).toMatchObject({
      fields: [
        {
          target: {
            screen: "browser",
            point: { x: 800, y: 600 },
            bbox: { x: 640, y: 580, w: 320, h: 40 },
            site: "mail.example.test",
          },
        },
      ],
    });
    f.session.answerFields(f.session.pendingAsk ?? "", { password: secret }, (t) => t);
    expect((await asking).result.ok).toBe(true);
    expect(f.client.secret.mock.calls.at(-1)?.at(2)).toMatchObject({
      origin: "https://mail.example.test",
      at: { x: 400, y: 300 },
      text: secret,
    });
    expect(f.client.type).not.toHaveBeenCalled();

    f.client.secret.mockClear();
    bindDesktop(h);
    const again = h.callTool("ask_user", login);
    await until(() => f.session.pendingAsk !== undefined);
    const generation = f.session.generation;
    if (!generation) throw new Error("the brain is gone");
    const lease = f.session.admit(generation);
    await f.session.switchScreen("desktop", lease);
    lease.finish();
    f.session.answerFields(f.session.pendingAsk ?? "", { password: secret }, (t) => t);
    const moved = await again;
    expect(moved.result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("The secure answer was not delivered."),
      }),
    );
    expect(f.client.type).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.read(f.id))).not.toContain(secret);
  });

  it.each(["739125", "Invite-Abc.123-XYZ"])(
    "delivers code %s privately without reading or updating saved logins",
    async (code) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      f.client.lookup.mockImplementation((async () => ({
        target: {
          point: { x: 400, y: 300 },
          source: "dom",
          role: "textbox",
          name: "Protected field",
          url: "https://github.com/sessions/two-factor",
          secret: true,
        },
        window: 0,
        ms: 1,
      })) as never);
      h.tools.logins = { login: vi.fn(), saveLogin: vi.fn() };
      // Even a mistaken rememberable reply cannot turn a code into a saved password.
      const asking = h.callTool("ask_user", {
        question: "Enter your authenticator code",
        fields: [{ id: "code", kind: "code", label: "Access code", target: [400, 300] }],
      });
      await until(() => f.session.pendingAsk !== undefined);
      f.session.answerFields(f.session.pendingAsk!, { code }, (text) => text);
      const answer = await asking;
      expect(answer.result.ok).toBe(true);
      expect(h.tools.logins.login).not.toHaveBeenCalled();
      expect(h.tools.logins.saveLogin).not.toHaveBeenCalled();
      expect(f.deps.fenceRecording).toHaveBeenCalled();
      expect(JSON.stringify(answer)).not.toContain(code);
      expect(JSON.stringify(f.log.read(f.id))).not.toContain(code);
    },
  );

  it.each([false, true])(
    "asks for a replacement after a rejected login (already saved: %s)",
    async (alreadySaved) => {
      const f = fixture();
      await f.browser();
      const h = tools(f);
      f.client.lookup.mockImplementation((async () => ({
        target: {
          point: { x: 400, y: 300 },
          source: "dom",
          role: "textbox",
          name: "Password",
          url: "https://github.com/login",
          secret: true,
        },
        window: 0,
        ms: 1,
      })) as never);
      let saved: { username: string; password: string } | undefined = alreadySaved
        ? { username: "fixture-user", password: "private-password-canary" }
        : undefined;
      h.tools.logins = {
        login: vi.fn(async () => saved && { ...saved }),
        saveLogin: vi.fn(async (_origin, username, password) => {
          saved = { username, password };
        }),
      };
      const input = {
        question: "Sign in",
        fields: [
          { id: "username", kind: "text", label: "Username" },
          { id: "password", kind: "secret", label: "Password", target: [400, 300] },
        ],
      };
      const first = h.callTool("ask_user", input);
      if (!alreadySaved) {
        await until(() => f.session.pendingAsk !== undefined);
        f.session.answerFields(
          f.session.pendingAsk ?? "",
          { username: "fixture-user", password: "private-password-canary" },
          (text) => text,
        );
      }
      const result = await first;
      expect(result.result.ok).toBe(true);
      if (alreadySaved) expect(JSON.stringify(result)).toContain("Used the saved sign-in");
      else
        expect(h.tools.logins.saveLogin).toHaveBeenCalledWith(
          "https://github.com",
          "fixture-user",
          "private-password-canary",
        );
      const asks = f.log.read(f.id).filter((e) => e.type === "ask.request").length;
      expect(f.client.secret.mock.calls.filter((call) => call[2].text !== undefined)).toHaveLength(
        1,
      );
      // A rejected saved login lets the user replace it instead of retrying forever.
      const replacement = h.callTool("ask_user", input);
      await until(() => f.session.pendingAsk !== undefined);
      f.session.answerFields(
        f.session.pendingAsk ?? "",
        { password: "replacement-password" },
        (text) => text,
      );
      expect((await replacement).result.ok).toBe(true);
      expect(saved?.password).toBe("replacement-password");
      expect(f.log.read(f.id).filter((e) => e.type === "ask.request")).toHaveLength(asks + 1);
      expect(
        f.client.secret.mock.calls
          .filter((call) => call[2].text !== undefined)
          .map((call) => call[2].text),
      ).toEqual(["private-password-canary", "replacement-password"]);
      expect(f.log.read(f.id).some((e) => e.type === "takeover.request")).toBe(false);
      expect(JSON.stringify([result, f.log.read(f.id)])).not.toMatch(
        /private-password-canary|replacement-password/,
      );
      // A second rejection must also ask, never silently replay the replacement.
      const again = h.callTool("ask_user", input);
      await until(() => f.session.pendingAsk !== undefined);
      f.session.answerFields(
        f.session.pendingAsk ?? "",
        { password: "third-password" },
        (text) => text,
      );
      await again;
    },
  );

  it("opens a public page in the web browser from the desktop by switching the screen first", async () => {
    const f = fixture();
    await f.ready();
    const h = tools(f),
      desktop = vi.spyOn(h.tools, "desktop");
    expect(f.screens.selection.screen).toBe("desktop");
    const navigated = await h.callTool("browser_navigate", { url: "https://mail.example.test/" });
    expect(navigated.result.ok).toBe(true);
    expect(f.screens.selection.screen).toBe("browser");
    expect(f.client.navigate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      "https://mail.example.test/",
      expect.any(Object),
    );
    expect(desktop).not.toHaveBeenCalled();
    expect(f.log.read(f.session.id).some((event) => event.type === "screen.switch")).toBe(true);
  });

  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:8000/",
    "https://example.test:8443/",
    "http://printer.local/",
    "http://intranet/",
  ])("keeps %s on the desktop, where dot's own servers run", async (url) => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    await h.callTool("browser_navigate", { url });
    expect(f.screens.selection.screen).toBe("desktop");
    expect(f.client.navigate).not.toHaveBeenCalled();
    expect(f.deps.browser.start).not.toHaveBeenCalled();
  });

  it("keeps saved sign-ins isolated when the browser cannot start, and retries in the same browser", async () => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    vi.mocked(f.deps.browser.start).mockRejectedValueOnce(new Error("browser cell stopped"));
    bindDesktop(h);
    const desktop = vi.spyOn(h.tools, "desktop");
    const navigated = await h.callTool("browser_navigate", { url: "https://mail.example.test/" });
    expect(navigated.result.ok).toBe(false);
    expect(navigated.result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Saved sign-ins are still kept"),
    });
    expect(f.screens.selection.screen).toBe("desktop");
    expect(desktop).not.toHaveBeenCalled();
    expect(f.client.navigate).not.toHaveBeenCalled();
    expect(f.session.stopped).toBe(false);
    const retry = await h.callTool("browser_navigate", { url: "https://mail.example.test/" });
    expect(retry.result.ok).toBe(true);
    expect(f.screens.selection.screen).toBe("browser");
    expect(desktop).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:5173/",
    "https://thema.localhost:1355/",
    "https://branch.app.localhost:8443/",
    "http://127.0.0.1:4173/",
    "http://[::1]:3000/",
  ])("shows the desktop preview for %s while the web browser is selected", async (url) => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    bindDesktop(h);
    expect((await h.callTool("switch_screen", { screen: "browser" })).result.ok).toBe(true);
    const desktop = vi.spyOn(h.tools, "desktop");
    const navigated = await h.callTool("browser_navigate", { url });
    expect(navigated.result.ok).toBe(true);
    expect(f.screens.selection.screen).toBe("desktop");
    expect(desktop).toHaveBeenCalledWith(f.session.cellId);
    expect(f.client.navigate).not.toHaveBeenCalled();
  });

  it("dispatches switch_screen through the real controller, clears the old frame and keeps shell/files on the desktop", async () => {
    const f = fixture();
    await f.ready();
    const h = tools(f);
    f.session.lastFrameId = ulid();
    const entered = await h.callTool("switch_screen", { screen: "browser" });
    expect(entered.result.ok).toBe(true);
    const explanation = entered.result.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n");
    expect(explanation).toContain("Switching selects a screen; it does not open a site");
    expect(explanation).toContain("localhost previews in desktop Chromium");
    expect(explanation).toContain("A blank initial tab is not a browser failure");
    expect(f.client.navigate).not.toHaveBeenCalled();
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

  it.each(["cannot start"] as const)(
    "keeps the task and the computer running when the signed-in browser %s",
    async (failure) => {
      const f = fixture(true);
      await f.ready();
      const h = tools(f);
      if (failure === "cannot start")
        vi.mocked(f.deps.browser.start).mockRejectedValueOnce(new Error("browser cell stopped"));
      const refused = await h.callTool("switch_screen", { screen: "browser" });
      expect(refused.result.ok).toBe(false);
      expect(refused.result.final).toBeUndefined();
      expect(refused.result.content).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining("web browser couldn't open") }),
      );
      expect(JSON.stringify(refused.result.content)).not.toMatch(/signed-in|starting|again/u);
      expect(f.session.stopped).toBe(false);
      expect(f.physicalStop).not.toHaveBeenCalled();
      expect(f.holder()).toBe("user");
      expect(f.screens.selection.screen).toBe("desktop");
      expect((await h.callTool("switch_screen", { screen: "browser" })).result.ok).toBe(true);
    },
  );

  it("lets dot start a stuck web browser again through switch_screen", async () => {
    const f = fixture(true);
    await f.ready();
    const h = tools(f);
    const restarted = await h.callTool("switch_screen", { screen: "browser", restart: true });
    expect(restarted.result.ok).toBe(true);
    expect(f.deps.browser.stop).toHaveBeenCalledExactlyOnceWith(f.session.cellId);
    expect(restarted.result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("saved sign-ins are kept") }),
    );
    expect(f.screens.selection.screen).toBe("browser");
    expect(
      (await h.callTool("switch_screen", { screen: "desktop", restart: true })).result.ok,
    ).toBe(true);
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it("waits for a settling browser tab before switching instead of handing the task back", async () => {
    const f = fixture(true);
    await f.ready();
    const h = tools(f);
    f.client.tabs.mockResolvedValueOnce({ tabs: [{ id: randomUUID(), ready: false }] });
    const switched = await h.callTool("switch_screen", { screen: "browser" });
    expect(switched.result.ok).toBe(true);
    expect(f.client.tabs.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.session.stopped).toBe(false);
    expect(f.physicalStop).not.toHaveBeenCalled();
    expect(f.screens.selection.screen).toBe("browser");
  });

  it("returns to the desktop when the signed-in browser stops answering, retiring only the browser", async () => {
    const f = fixture(true);
    await f.browser();
    const h = tools(f);
    f.client.control.mockRejectedValueOnce(new Error("browser stopped answering"));
    const back = await h.callTool("switch_screen", { screen: "desktop" });
    expect(back.result.ok).toBe(true);
    expect(f.screens.selection.screen).toBe("desktop");
    expect(f.deps.browser.stop).toHaveBeenCalledWith(f.session.cellId);
    expect(f.session.stopped).toBe(false);
    expect(f.physicalStop).not.toHaveBeenCalled();
  });

  it("still stops the task and its computer when the browser grant can neither be revoked nor retired", async () => {
    const f = fixture(true);
    await f.browser();
    const h = tools(f);
    f.client.control.mockRejectedValueOnce(new Error("browser stopped answering"));
    vi.mocked(f.deps.browser.stop).mockRejectedValueOnce(new Error("shutdown unconfirmed"));
    const back = await h.callTool("switch_screen", { screen: "desktop" });
    expect(back.result).toMatchObject({ ok: false, final: true });
    expect(f.session.stopped).toBe(true);
    await f.session.screensSettled().catch(() => {});
    expect(f.physicalStop).toHaveBeenCalledWith(f.session.cellId);
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

  it("refuses a mouse button held between actions on the browser screen, before any input", async () => {
    const f = fixture();
    await f.browser();
    const h = tools(f);
    for (const action of ["mouse_down", "mouse_up"]) {
      const held = await h.call({ action });
      expect(held.result).toEqual({
        ok: false,
        content: [
          {
            type: "text",
            text: "Holding a mouse button between actions is not available on the browser screen; drag with left_click_drag instead.",
          },
        ],
      });
    }
    expect(h.actions).toEqual([]);
  });

  it("lets go of a held button before it switches screens", async () => {
    const f = fixture();
    const generation = await f.ready();
    const releasing = Promise.withResolvers<void>();
    const release = vi.fn(() => releasing.promise);
    f.session.holdInput(release);
    const lease = f.session.admit(generation);
    const switching = f.session.switchScreen("browser", lease);
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledOnce();
    expect(f.deps.browser.start).not.toHaveBeenCalled();
    releasing.resolve();
    await switching;
    lease.finish();
    expect(f.deps.browser.start).toHaveBeenCalled();
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

  it("forgets the page's refs on a screen switch and refuses an act by one of them", async () => {
    const f = fixture();
    const generation = await f.browser();
    const h = tools(f);
    const next = {
      ref: "e42",
      role: "button",
      name: "Next",
      box: { x: 560, y: 285, w: 80, h: 30 },
    };
    f.client.read.mockImplementation((async () => ({
      url: "https://example.test/",
      title: "Owned browser page",
      text: "Public page text",
      outline: "button Next",
      truncated: false,
      elements: [next],
    })) as never);
    expect((await h.callTool("browser_read", {})).result.ok).toBe(true);
    expect(f.session.pageRefs?.elements.has("e42")).toBe(true);
    const lease = f.session.admit(generation);
    await f.session.switchScreen("desktop", lease);
    await f.session.switchScreen("browser", lease);
    lease.finish();
    expect(f.session.pageRefs).toBeUndefined();
    // Back on the same tab, the button is still there to be found and clicked.
    f.client.lookup.mockImplementation((async () => ({
      target: {
        point: { x: 1200, y: 600 },
        bbox: { x: 1120, y: 570, w: 160, h: 60 },
        source: "dom",
        role: "button",
        name: "Next",
        url: "https://example.test/",
      },
      window: 0,
      ms: 1,
    })) as never);
    f.client.input.mockImplementation((async () => ({
      pressMono: 1,
      presses: [1],
      injector: "xtest",
      armedMono: 0,
    })) as never);
    const act = await h.callTool("browser_act", { action: "click", ref: "e42" });
    expect(act.result.ok).toBe(false);
    expect(act.result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("e42 is not in this screen's last page read"),
      }),
    );
    expect(f.client.input).not.toHaveBeenCalled();
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
    expect(manual.returning.aborted).toBe(true);
    expect(manual.signal.aborted).toBe(false);
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
