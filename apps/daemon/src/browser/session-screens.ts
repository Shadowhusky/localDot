import { ManualInput } from "@localdot/protocol";
import type { ScreenName } from "../../../../packages/protocol/src/screens.ts";
import { type ManualDesktop, ManualInputRejected } from "../agent/manual-input.ts";
import type { AgentSession } from "../agent/session.ts";
import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import type { CellSummary } from "../cells/types.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { ScreenRecordings } from "../recorder/screen-recordings.ts";
import { BrowserClient, type BrowserScope, checkManualBrowserInput } from "./client.ts";
import type { BrowserDownloadCollector } from "./download-collector.ts";
import { BrowserDownloadPump } from "./download-pump.ts";
import { screenGatewayBinding } from "./gateway-binding.ts";
import {
  ScreenController,
  type ScreenControllerDeps,
  type ScreenLease,
} from "./screen-controller.ts";
import { type BrowserSlots, browserLane, NoBrowserRoom } from "./slots.ts";
import type { BrowserStreams } from "./streams.ts";

const KEPT_REVISIONS = 16;

// What dot hears when its conversation's own browser can't run and it shares the main one.
export const SHARED_BROWSER =
  "localDot: this conversation's own web browser couldn't run now, so you share the computer's main web browser, in a window of your own, with another task; you take turns with it. Its sign-ins are the main browser's.";

export class SessionScreens {
  readonly #revisions = new Map<string, number>();

  constructor(
    private readonly deps: {
      cells: Pick<CellApi, "get" | "subscribe" | "stop">;
      browser: Pick<BrowserOrchestrator, "start" | "endpoints" | "stop" | "get"> &
        Partial<Pick<BrowserOrchestrator, "health">>;
      // A browser per conversation; without it every task shares the computer's main browser.
      slots?: Pick<BrowserSlots, "claim" | "admit" | "share" | "release" | "sessionsOn" | "keyOf">;
      // The first task of the conversation a task belongs to.
      conversationOf?(sessionId: string): string;
      client?(endpoint: ReadyBrowser): ReturnType<NonNullable<ScreenControllerDeps["client"]>>;
      streams: BrowserStreams;
      recordings: Pick<ScreenRecordings, "attach" | "fence"> &
        Partial<Pick<ScreenRecordings, "coming" | "up">>;
      registry: Pick<DesktopdRegistry, "for">;
      downloads?: Pick<BrowserDownloadCollector, "collect">;
      pendingStop?(sessionId: string): Promise<StopOutcome> | undefined;
      live?: Pick<LiveSessions, "lease" | "sessionsOn">;
      report?(message: string): void;
      now(): number;
    },
  ) {}

  // The live tasks using the same web browser as this one, itself included.
  sharing(sessionId: string): string[] {
    const key = this.deps.slots?.keyOf(sessionId);
    return key ? (this.deps.slots?.sessionsOn(key) ?? [sessionId]) : [sessionId];
  }

  async startBrowser(cellId: string): Promise<void> {
    await this.deps.browser.start(cellId);
  }

  workEndpoint(session: AgentSession): { baseUrl: string; token: string } | undefined {
    if (session.screens?.selection.screen !== "browser") return undefined;
    const endpoint = this.deps.browser.endpoints(session.screens.browserKey);
    return endpoint?.browserCellId === session.screens.selection.cellId
      ? endpoint.browserd
      : undefined;
  }

  // The browser a task uses, picked at its first use, and room made for it. A conversation's own
  // browser that can't run leaves the task sharing the main one, told so.
  #lane(session: AgentSession, cell: CellSummary): ScreenControllerDeps["lane"] {
    const slots = this.deps.slots;
    if (!slots) return undefined;
    return {
      claim: async (signal) => {
        const key = slots.claim({
          sessionId: session.id,
          parentCellId: cell.id,
          conversation: this.deps.conversationOf?.(session.id) ?? session.id,
          guest: !!session.guest,
        });
        if (key === cell.id) return key;
        try {
          await slots.admit(key);
          signal.throwIfAborted();
          await this.deps.browser.start(key, signal);
          return key;
        } catch (error) {
          signal.throwIfAborted();
          const shared = slots.share(session.id);
          this.deps.report?.(
            `a conversation's own web browser couldn't run (${
              error instanceof NoBrowserRoom
                ? "no room"
                : error instanceof Error
                  ? error.message
                  : "unknown"
            }); its task shares the main one`,
          );
          session.remind(SHARED_BROWSER);
          return shared;
        }
      },
      release: () => slots.release(session.id),
    };
  }

  install(session: AgentSession, cell: CellSummary, freshTab = false, continues?: string): void {
    if (session.cellId !== cell.id) throw new Error("The session computer changed.");
    const lane = this.#lane(session, cell);
    const slots = this.deps.slots;
    session.attachScreens(
      new ScreenController({
        sessionId: session.id,
        parentCellId: cell.id,
        freshTab,
        ...(continues ? { continues } : {}),
        ...(lane ? { lane } : {}),
        ...(this.deps.client ? { client: this.deps.client } : {}),
        desktopGeometry: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
        desktopReady: () => {
          const current = this.deps.cells.get(cell.id);
          return (
            current?.state === "ready" &&
            current.scale === cell.scale &&
            !current.paused &&
            !current.fenced &&
            !current.replacementPending
          );
        },
        browser: this.deps.browser,
        ...(this.deps.report ? { report: this.deps.report } : {}),
        revision: (instance) => this.#revision(instance),
        downloads: this.deps.downloads
          ? (endpoint, binding, owner) => {
              const collector = this.deps.downloads;
              if (
                !collector ||
                binding.sessionId !== session.id ||
                binding.permit.parentCellId !== cell.id
              )
                throw new Error("The browser download session changed.");
              const generation = session.generation;
              if (binding.holder === "agent" && generation?.id !== binding.permit.owner.generation)
                throw new Error("The browser download generation changed.");
              const signal = AbortSignal.any([
                owner.signal,
                session.abort.signal,
                ...(binding.holder === "agent" && generation ? [generation.signal] : []),
              ]);
              const check = () => {
                signal.throwIfAborted();
                owner.check();
                if (session.stopped) throw new Error("The browser download session ended.");
                if (binding.holder === "agent") {
                  if (!generation) throw new Error("The browser download generation changed.");
                  // Handback installs the grant before releasing the user-control record.
                  // The screen owner independently revokes this exact permit on takeover.
                  session.check(generation, undefined, true);
                }
                // Brain retirement also holds the browser for the user without
                // creating a manual-takeover request. owner.check() validates the
                // exact physical user grant and revokes it before any handback.
                // Collection only quarantines bytes; it grants no input or release.
              };
              check();
              return new BrowserDownloadPump({
                client: new BrowserClient(endpoint),
                collector,
                binding,
                scope: { signal, check },
              });
            }
          : undefined,
        attachRecording: (selection, scope) =>
          this.deps.recordings.attach(session.id, selection, scope),
        fenceRecording: () => this.deps.recordings.fence(session.id),
        publish: (event) => session.append("screen.switch", event),
        fenceSession: () => session.stop(),
        remind: (text) => session.remind(text),
        ...(this.deps.live
          ? {
              turn: (signal: AbortSignal, key: string) =>
                (this.deps.live as NonNullable<typeof this.deps.live>)
                  .lease(slots ? browserLane(key) : cell.id)
                  .acquire(session.id, { signal }),
              // With a browser per conversation, a browser's recordings are of the tasks using it.
              coming: (screen: ScreenName, key: string) =>
                screen === "browser" && slots
                  ? this.deps.recordings.coming?.(
                      browserLane(key),
                      session.id,
                      screen,
                      slots.sessionsOn(key),
                    )
                  : this.deps.recordings.coming?.(
                      cell.id,
                      session.id,
                      screen,
                      this.deps.live?.sessionsOn(cell.id) ?? [],
                    ),
              up: (screen: ScreenName) => this.deps.recordings.up?.(session.id, screen),
            }
          : {}),
        contain: async () => {
          const stopping = this.deps.pendingStop?.(session.id);
          if (stopping) {
            try {
              const outcome = await stopping;
              if (outcome.revoked && (outcome.paused || (outcome.closed && outcome.stopped)))
                return;
            } catch {
              // An unconfirmed central Stop still requires physical fallback.
            }
          }
          if (this.deps.cells.get(cell.id)) await this.deps.cells.stop(cell.id);
        },
      }),
    );
  }

  #revision(instance: string): number {
    const next = (this.#revisions.get(instance) ?? 0) + 1;
    this.#revisions.delete(instance);
    this.#revisions.set(instance, next);
    for (const old of this.#revisions.keys()) {
      if (this.#revisions.size <= KEPT_REVISIONS) break;
      this.#revisions.delete(old);
    }
    return next;
  }

  bind(session: AgentSession, lease: ScreenLease) {
    const screens = session.screens;
    if (!screens) throw new Error("The session screens are unavailable.");
    return screenGatewayBinding(
      {
        parentCellId: session.cellId,
        screens,
        registry: this.deps.registry,
        now: this.deps.now,
        stream: (selection) => {
          const cell =
            selection.screen === "browser"
              ? this.deps.streams.get(selection.cellId)
              : this.deps.cells.get(session.cellId);
          if (cell?.id !== selection.cellId) throw new Error("The selected screen changed.");
          return cell.stream;
        },
        subscribe: (selection, listener) =>
          (selection.screen === "browser" ? this.deps.streams : this.deps.cells).subscribe(
            (cell) => {
              if (cell.id === selection.cellId) listener();
            },
          ),
      },
      lease,
    );
  }

  manual(session: AgentSession, scope: BrowserScope): ManualDesktop {
    const screens = session.screens;
    if (!screens) throw new Error("The selected browser is unavailable.");
    // With dot on the desktop, the user's first input here is what takes the web browser.
    let access = screens.selection.screen === "browser" ? screens.manualAccess(scope) : undefined;
    const held = () => {
      if (!access) throw new Error("The selected browser is unavailable.");
      return access;
    };
    return {
      screen: screens.selection.geometry,
      check: () => (access ? access.check() : scope.check()),
      prepare: async (input) => {
        if (!access) {
          await screens.reachBrowser(scope);
          access = screens.manualAccess(scope);
        }
        access.check();
        try {
          checkManualBrowserInput(input);
        } catch {
          throw new ManualInputRejected();
        }
      },
      release: () => access?.finish(),
      confirm: () => held().confirm(),
      client: {
        input: async (request, signal) => {
          const result = await held().input(ManualInput.parse(request.input), signal);
          if (result.kind !== "input") throw new Error("Manual input was not confirmed.");
          return result.receipt;
        },
        type: async (request, _onProgress, signal) => {
          const result = await held().input({ kind: "text", text: request.text }, signal);
          if (result.kind !== "text") throw new Error("Manual input was not confirmed.");
          return result.receipt;
        },
      },
    };
  }
}
