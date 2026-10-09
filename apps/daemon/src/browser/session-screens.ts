import { ManualInput } from "@localdot/protocol";
import { type ManualDesktop, ManualInputRejected } from "../agent/manual-input.ts";
import type { AgentSession } from "../agent/session.ts";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import type { CellSummary } from "../cells/types.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import type { ScreenRecordings } from "../recorder/screen-recordings.ts";
import { BrowserClient, type BrowserScope, checkManualBrowserInput } from "./client.ts";
import type { BrowserDownloadCollector } from "./download-collector.ts";
import { BrowserDownloadPump } from "./download-pump.ts";
import { screenGatewayBinding } from "./gateway-binding.ts";
import { ScreenController, type ScreenLease } from "./screen-controller.ts";
import type { BrowserStreams } from "./streams.ts";

const KEPT_REVISIONS = 16;

export class SessionScreens {
  readonly #revisions = new Map<string, number>();

  constructor(
    private readonly deps: {
      cells: Pick<CellApi, "get" | "subscribe" | "stop">;
      browser: Pick<BrowserOrchestrator, "start" | "endpoints" | "stop" | "get"> &
        Partial<Pick<BrowserOrchestrator, "health">>;
      streams: BrowserStreams;
      recordings: Pick<ScreenRecordings, "attach" | "fence">;
      registry: Pick<DesktopdRegistry, "for">;
      downloads?: Pick<BrowserDownloadCollector, "collect">;
      pendingStop?(sessionId: string): Promise<StopOutcome> | undefined;
      report?(message: string): void;
      now(): number;
    },
  ) {}

  install(session: AgentSession, cell: CellSummary): void {
    if (session.cellId !== cell.id) throw new Error("The session computer changed.");
    session.attachScreens(
      new ScreenController({
        sessionId: session.id,
        parentCellId: cell.id,
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
              ? this.deps.streams.forParent(session.cellId)
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
    const access = session.screens?.manualAccess(scope);
    if (!access) throw new Error("The selected browser is unavailable.");
    return {
      screen: access.selection.geometry,
      check: access.check,
      prepare: async (input) => {
        access.check();
        try {
          checkManualBrowserInput(input);
        } catch {
          throw new ManualInputRejected();
        }
      },
      release: access.finish,
      client: {
        input: async (request, signal) => {
          const result = await access.input(ManualInput.parse(request.input), signal);
          if (result.kind !== "input") throw new Error("Manual input was not confirmed.");
          return result.receipt;
        },
        type: async (request, _onProgress, signal) => {
          const result = await access.input({ kind: "text", text: request.text }, signal);
          if (result.kind !== "text") throw new Error("Manual input was not confirmed.");
          return result.receipt;
        },
      },
    };
  }
}
