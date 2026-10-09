import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import {
  CHATGPT_SWITCHED_OFF,
  CODEX_VERSION,
  CodexInstallError,
  type CodexInstaller,
  codexAccepted,
  type HarnessAvailability,
  harnessAvailability,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
} from "@localdot/codex-harness";
import { type SkillSummary, TOOL_API_PORT } from "@localdot/protocol";
import type { BrowserScope } from "../browser/client.ts";
import { desktopPlacement } from "../browser/placement.ts";
import type { QuarantineStore } from "../browser/quarantine.ts";
import { quarantineAccess } from "../browser/quarantine-access.ts";
import type { ScreenLease } from "../browser/screen-controller.ts";
import type { SessionScreens } from "../browser/session-screens.ts";
import type { DockerClient } from "../cells/docker.ts";
import { CellControlConflict, type CellOrchestrator } from "../cells/orchestrator.ts";
import type { PortRange } from "../cells/ports.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "../gateway/frames.ts";
import type { ActionGateway } from "../gateway/gateway.ts";
import type { KillSwitch } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { KeydClient } from "../keyd/client.ts";
import { JudgeCell } from "../keyd/judge-cell.ts";
import type { KeydMonitor } from "../keyd/monitor.ts";
import { runtimeLayout } from "../runtime-layout.ts";
import { BrainCells, imagesWithBrain } from "./brain-cell.ts";
import { CatalogStore } from "./catalog-store.ts";
import { CodexAuthOwner } from "./codex/auth-owner.ts";
import { CodexDriver } from "./codex/driver.ts";
import { codexInstructions } from "./codex/instructions.ts";
import { openMcpEndpoint } from "./codex/mcp-endpoint.ts";
import { Conversations } from "./conversation.ts";
import { FramePng } from "./frame-png.ts";
import type { ManualDesktop } from "./manual-input.ts";
import { MemoryStore } from "./memory.ts";
import { OutputStore } from "./output-store.ts";
import type { ToolPolicy } from "./policy.ts";
import { redactor } from "./redact.ts";
import type { AgentRoutesDeps, UploadAccess } from "./routes.ts";
import { AgentError, AgentRunner } from "./runner.ts";
import { taintMemory } from "./safety/taint.ts";
import type { AgentSession } from "./session.ts";
import { SettingsStore } from "./settings.ts";
import { listSkills, skillDesktopPath, skillFiles } from "./skills.ts";
import { createToolApi } from "./tool-api.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";
import { TranscriptStore } from "./transcript.ts";
import { type TransferLease, Transfers } from "./transfers.ts";
export interface AgentWiringDeps {
  fences?: import("./safety/fences.ts").ComputerFences;
  home: string;
  installToken: string;
  eventLog: EventLog;
  live: LiveSessions;
  cells: Pick<
    CellOrchestrator,
    "get" | "list" | "record" | "endpoints" | "subscribe" | "reservedKeydPorts"
  >;
  registry: Pick<DesktopdRegistry, "for">;
  gateway: ActionGateway;
  frames: FrameStore;
  docker: DockerClient;
  keyd: KeydClient;
  monitor: Pick<KeydMonitor, "health">;
  killSwitch: Pick<KillSwitch, "stopSession" | "isBusy">;
  keydPorts: PortRange;
  policy?: ToolPolicy;
  toolPort?: number;
  codex?: { realHome: string; user: string };
  sessionScreens?: Pick<SessionScreens, "install" | "bind" | "manual">;
  transfers?: Transfers;
  quarantine?: QuarantineStore;
}
export const BUILTIN_SKILLS = runtimeLayout.skills;
// The Codex path hands memory to the model here.
function tainting<T extends { user: string; memory: string }>(session: AgentSession, memory: T): T {
  taintMemory(session.taint, memory);
  return memory;
}

export function createAgent(d: AgentWiringDeps) {
  const memory = new MemoryStore(d.home),
    settings = new SettingsStore(d.home),
    catalog = new CatalogStore(d.home);
  const conversations = new Conversations(d.home, d.eventLog);
  const transcripts = new TranscriptStore(d.home),
    png = new FramePng(d.frames, d.gateway),
    outputs = new OutputStore(d.home),
    transfers = d.transfers ?? new Transfers();
  const clients = new Map<string, DesktopdTools>();
  const retiring = new Set<Promise<void>>();
  let ready = false,
    closing = false;
  const retire = (tools: DesktopdTools) => {
    const pending = tools.close();
    retiring.add(pending);
    void pending.catch(() => {}).finally(() => retiring.delete(pending));
  };
  const desktop = (cellId: string): DesktopdTools | undefined => {
    if (closing) return undefined;
    const endpoint = d.cells.endpoints(cellId)?.desktopd;
    const previous = clients.get(cellId);
    if (
      previous &&
      (!endpoint ||
        endpoint.baseUrl !== previous.endpoint.baseUrl ||
        endpoint.token !== previous.endpoint.token)
    ) {
      clients.delete(cellId);
      retire(previous);
      transfers.abortCell(cellId);
    }
    if (!endpoint) return undefined;
    const current = clients.get(cellId);
    if (current) return current;
    const created = new DesktopdTools(endpoint);
    clients.set(cellId, created);
    return created;
  };
  const failedPreparations = new Set<string>();
  const prepareDesktop = async (cellId: string, sessionId: string, signal: AbortSignal) => {
    await transfers.wait(cellId, signal);
    signal.throwIfAborted();
    const tools = desktop(cellId);
    if (!tools) throw new AgentError(409, "the computer is not ready");
    const check = () => {
      signal.throwIfAborted();
      const cell = d.cells.get(cellId);
      if (
        !ready ||
        closing ||
        failedPreparations.has(cellId) ||
        d.fences?.isFenced(cellId) ||
        !cell ||
        cell.state !== "ready" ||
        cell.paused ||
        cell.fenced ||
        cell.replacementPending ||
        d.killSwitch.isBusy(cellId) ||
        d.live.get(cellId) !== sessionId ||
        desktop(cellId) !== tools
      )
        throw new AgentError(409, "the computer changed");
    };
    const lease = transfers.acquire(cellId, [signal], check);
    try {
      await tools.prepareBrowser(sessionId, lease.signal);
      lease.check();
    } finally {
      lease.release();
    }
  };
  const unsubscribe = d.cells.subscribe((cell) => {
    const prior = clients.get(cell.id),
      endpoint = d.cells.endpoints(cell.id)?.desktopd;
    if (
      cell.state !== "ready" ||
      cell.paused ||
      cell.fenced ||
      cell.replacementPending ||
      (prior &&
        (endpoint?.token !== prior.endpoint.token || endpoint.baseUrl !== prior.endpoint.baseUrl))
    ) {
      transfers.abortCell(cell.id);
      if (prior) {
        clients.delete(cell.id);
        retire(prior);
      }
    }
  });
  const brains = new BrainCells({
    docker: d.docker,
    keyd: d.keyd,
    images: imagesWithBrain(),
    home: d.home,
    range: d.keydPorts,
    desktopPorts: () => d.cells.reservedKeydPorts(),
    ...(d.toolPort === undefined ? {} : { toolPort: d.toolPort }),
  });
  const judgeCell = new JudgeCell({
    keyd: d.keyd,
    ports: { reserve: () => brains.reservePort(), release: (port) => brains.releasePort(port) },
  });
  const skills = () => listSkills(BUILTIN_SKILLS, join(d.home, "skills"));
  const installSkills = async (cellId: string, signal: AbortSignal): Promise<SkillSummary[]> => {
    signal.throwIfAborted();
    const tools = desktop(cellId);
    if (!tools) throw new AgentError(409, "the computer is not ready");
    const installed: SkillSummary[] = [];
    for (const skill of skills()) {
      for (const file of skillFiles(skill)) {
        signal.throwIfAborted();
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(file.bytes);
            controller.close();
          },
        });
        await tools.putFile(`.skills/${skill.name}/${file.rel}`, source, file.mode, signal);
        signal.throwIfAborted();
      }
      installed.push({
        name: skill.name,
        description: skill.description,
        path: skillDesktopPath(skill.name),
      });
    }
    return installed;
  };
  let roots: OwnedCodexRoots | undefined;
  if (d.codex) {
    try {
      roots = prepareOwnedCodexRoots(d.home, d.codex.realHome);
    } catch {
      /* Capability stays unavailable; no unvalidated roots are used or cleaned. */
    }
  }
  const platform = (): HarnessAvailability => {
    if (!d.codex) return { available: false, reason: CHATGPT_SWITCHED_OFF };
    if (!roots) return { available: false, reason: "The ChatGPT storage could not be validated." };
    if (closing) return { available: false, reason: "The ChatGPT account service is closed." };
    return harnessAvailability();
  };
  const harness = (): HarnessAvailability => {
    const availability = platform();
    return availability.available && !codexAccepted()
      ? { available: false, reason: CHATGPT_SWITCHED_OFF }
      : availability;
  };
  const auth = roots
    ? new CodexAuthOwner({
        roots,
        sessions: () =>
          [...runner.sessions.values()].filter((session) => runner.isChatgpt(session.id)),
        taskDenyRead: (id) => runner.codexDenyReadOf(id),
        pauseForAuth: (session, generation) => runner.pauseForAuth(session, generation),
      })
    : undefined;
  const installWork = new Set<Promise<unknown>>();
  const tracked = <T>(work: Promise<T>): Promise<T> => {
    installWork.add(work);
    void work.catch(() => {}).finally(() => installWork.delete(work));
    return work;
  };
  const installer: CodexInstaller | undefined = auth
    ? {
        status: () => auth.installer.status(),
        ensureInstalled: (signal) =>
          closing
            ? Promise.reject(new CodexInstallError("cancelled"))
            : tracked(auth.installer.ensureInstalled(signal)),
        verifiedInstallation: (signal) => tracked(auth.installer.verifiedInstallation(signal)),
        cancel: () => auth.installer.cancel(),
      }
    : undefined;
  const dispatch: DispatchDeps = {
    ...(d.policy ? { policy: d.policy } : {}),
    tools: {
      uploads: { desktop, transfers },
      gateway: d.gateway,
      bindScreen: d.sessionScreens?.bind.bind(d.sessionScreens),
      scaleOf: (id) => d.cells.get(id)?.scale,
      desktop,
      launcher: (id) => d.registry.for(id)?.client,
      device: (id) => {
        const cell = d.cells.get(id);
        return !ready ||
          closing ||
          cell?.state !== "ready" ||
          cell.paused ||
          cell.fenced ||
          cell.replacementPending ||
          d.killSwitch.isBusy(id)
          ? undefined
          : d.registry.for(id);
      },
      png,
      memory,
      saveOutput: (id, name, source, scope) => outputs.save(id, name, source, scope),
      stopForUncertainty: (session, reason) => runner.contain(session, reason),
      sleep: (ms, signal) => sleep(ms, undefined, { signal }),
    },
  };
  const driver =
    auth && roots
      ? new CodexDriver({
          auth,
          transcripts,
          openEndpoint: (input) =>
            openMcpEndpoint({
              ...input,
              roots,
              dispatch: (name, callId, args, context) =>
                dispatchTool(
                  dispatch,
                  input.session,
                  name,
                  callId,
                  args,
                  forText(input.session),
                  context.generation,
                  context.signal,
                ),
            }),
          observe: async (session, generation, signal) => {
            const lease = session.admit(generation, signal);
            let screen: ScreenLease | undefined;
            const endpoint = d.cells.endpoints(session.cellId)?.desktopd;
            const check = () => {
              lease.check();
              screen?.check();
              const cell = d.cells.get(session.cellId),
                current = d.cells.endpoints(session.cellId)?.desktopd;
              if (
                !ready ||
                closing ||
                !d.monitor.health.online ||
                cell?.state !== "ready" ||
                cell.paused ||
                d.killSwitch.isBusy(session.cellId) ||
                !endpoint ||
                current?.token !== endpoint.token ||
                current.baseUrl !== endpoint.baseUrl
              )
                throw new AgentError(409, "The task computer changed during observation.");
            };
            try {
              screen = session.screens ? session.screenLease(lease) : undefined;
              const binding = screen ? d.sessionScreens?.bind(session, screen) : undefined;
              if (screen && !binding)
                throw new AgentError(409, "The selected screen is unavailable.");
              const observationSignal = screen
                ? AbortSignal.any([lease.signal, screen.signal])
                : lease.signal;
              check();
              const frame = await d.gateway.observe({
                sessionId: session.id,
                cellId: binding?.cellId ?? session.cellId,
                signal: observationSignal,
                ...(binding ? { screen: binding } : {}),
              });
              check();
              const full = await png.png(session.id, frame.frameId, undefined, observationSignal);
              check();
              session.tainted = true;
              const shown = screen?.selection.screen ?? "desktop";
              if (session.taskAutonomy.signedIn(shown))
                session.taint.add("screen", `${shown} screen`);
              session.lastFrameId = frame.frameId;
              return { frameId: frame.frameId, full: true, png: full };
            } finally {
              screen?.finish();
              lease.finish();
            }
          },
          instructions: (session) =>
            codexInstructions({
              memory: tainting(session, memory.readBoth()),
              skills: runner.skillsOf(session.id),
              today: new Date(),
            }),
          redactorFor: (session) => forText(session),
          waitForAuthResume: (session) => runner.waitForAuthResume(session),
        })
      : undefined;
  const runner = new AgentRunner({
    home: d.home,
    installSession: d.sessionScreens?.install.bind(d.sessionScreens),
    fences: d.fences,
    eventLog: d.eventLog,
    live: d.live,
    cell: (id) => d.cells.get(id),
    cellBusy: (id) => !ready || closing || d.killSwitch.isBusy(id),
    brains,
    keyd: d.keyd,
    keydHealth: () => d.monitor.health,
    settings: () => settings.get(),
    catalog: () => catalog.get(),
    memory,
    transcripts,
    conversations,
    installSkills,
    prepareDesktop: (session) => prepareDesktop(session.cellId, session.id, session.abort.signal),
    waitForUploads: (id, signal) => transfers.wait(id, signal),
    stopSession: (id) => d.killSwitch.stopSession(id),
    jev: (secretId, body, signal) => judgeCell.post(secretId, body, signal),
    ...(driver && auth
      ? {
          codex: {
            driver,
            authGeneration: () => auth.authGeneration,
            account: {
              status: async (opts) => {
                const availability = harness();
                return availability.available
                  ? auth.status(opts)
                  : { ...availability, codexVersion: CODEX_VERSION, state: "unavailable" as const };
              },
            },
          },
        }
      : {}),
  });
  const forText = (session?: AgentSession, cellId = session?.cellId) => {
    const record = cellId ? d.cells.record(cellId) : undefined;
    return redactor([
      d.installToken,
      session?.toolToken,
      session?.boot?.proxy.token,
      record?.tokens.desktopd,
      record?.tokens.stream,
    ]);
  };
  const upload = (cellId: string, requestSignal: AbortSignal): UploadAccess | undefined => {
    const sessionId = d.live.get(cellId),
      session = sessionId ? runner.get(sessionId) : undefined;
    const cell = d.cells.get(cellId),
      tools = desktop(cellId);
    if (!cell || !tools) return undefined;
    const check = () => {
      requestSignal.throwIfAborted();
      const current = d.cells.get(cellId),
        endpoint = d.cells.endpoints(cellId)?.desktopd;
      if (
        closing ||
        !ready ||
        current?.state !== "ready" ||
        current.paused ||
        d.killSwitch.isBusy(cellId) ||
        endpoint?.token !== tools.endpoint.token ||
        endpoint.baseUrl !== tools.endpoint.baseUrl
      )
        throw new AgentError(409, "the computer changed during the upload");
      if (
        session &&
        (session.stopped ||
          session.controlHeld ||
          (!session.generation && session.status !== "idle"))
      )
        throw new AgentError(
          409,
          "the task is changing control; retry the upload when it is ready",
        );
    };
    check();
    const generation = session?.generation;
    const toolLease = session && generation ? session.admit(generation, requestSignal) : undefined;
    let transfer: TransferLease;
    try {
      transfer = transfers.acquire(
        cellId,
        [
          requestSignal,
          ...(toolLease ? [toolLease.signal] : session ? [session.abort.signal] : []),
        ],
        () => {
          check();
          toolLease?.check();
        },
      );
    } catch (error) {
      toolLease?.finish();
      throw error;
    }
    return {
      tools,
      signal: transfer.signal,
      check: transfer.check,
      release: () => {
        transfer.release();
        toolLease?.finish();
      },
    };
  };
  const manual = (session: AgentSession, scope: BrowserScope): ManualDesktop | undefined => {
    const cell = d.cells.get(session.cellId);
    if (!cell) throw new AgentError(404, "the computer is unavailable");
    const browser = session.screens?.selection.screen === "browser";
    const target = browser ? undefined : d.registry.for(session.cellId);
    if (!browser && !target) return undefined;
    const endpoint = target?.client.endpoint;
    const check = () => {
      scope.check();
      const current = d.cells.get(session.cellId);
      const now = d.cells.endpoints(session.cellId)?.desktopd;
      if (
        closing ||
        !ready ||
        session.stopped ||
        runner.get(session.id) !== session ||
        d.live.get(session.cellId) !== session.id ||
        current?.state !== "ready" ||
        current.paused ||
        current.fenced ||
        current.replacementPending ||
        current.scale !== cell.scale ||
        d.killSwitch.isBusy(session.cellId) ||
        (!browser && (now?.baseUrl !== endpoint?.baseUrl || now?.token !== endpoint?.token))
      )
        throw new AgentError(409, "manual control changed");
    };
    check();
    const unsubscribe = d.cells.subscribe((next) => {
      if (next.id !== session.cellId) return;
      try {
        check();
      } catch {
        session.cancelManual();
      }
    });
    if (browser) {
      try {
        const access = d.sessionScreens?.manual(session, { signal: scope.signal, check });
        if (!access) throw new AgentError(503, "manual browser control is unavailable");
        return {
          ...access,
          release: () => {
            try {
              access.release();
            } finally {
              unsubscribe();
            }
          },
        };
      } catch (error) {
        unsubscribe();
        throw error;
      }
    }
    if (!target) {
      unsubscribe();
      throw new AgentError(503, "manual control is unavailable");
    }
    return {
      screen: { w: 1280 * cell.scale, h: 800 * cell.scale },
      client: target.client,
      check,
      prepare: async () => {
        if (!target.clocks.sample) await target.clocks.sync();
      },
      release: unsubscribe,
      letGo: async () => {
        await target.client.release();
      },
    };
  };
  const toolApp = createToolApi({
    ...dispatch,
    sessions: () => runner.sessions.values(),
    transcripts,
    png,
    redactorFor: (session) => forText(session),
  });
  const routes: AgentRoutesDeps = {
    quarantine: d.quarantine
      ? {
          store: d.quarantine,
          exists: (id) => !!d.cells.get(id),
          place: desktopPlacement((id) => d.cells.endpoints(id)?.desktopd),
          access: (id, signal) =>
            quarantineAccess(
              {
                transfers,
                available: () => ready && !closing,
                cell: (id) => d.cells.get(id),
                endpoint: (id) => d.cells.endpoints(id)?.desktopd,
                session: (id) => {
                  const live = d.live.get(id);
                  return live ? runner.get(live) : undefined;
                },
                busy: (id) => d.killSwitch.isBusy(id),
              },
              id,
              signal,
            ),
        }
      : undefined,
    runner,
    conversations,
    settings,
    catalog,
    keyd: d.keyd,
    memory,
    skills,
    canChangeMemory: () =>
      [...runner.sessions.values()].every(
        (session) => !session.controlHeld && !d.killSwitch.isBusy(session.cellId),
      ),
    taskMutationReady: (session) =>
      runner.sessions.get(session.id) === session &&
      d.cells.get(session.cellId)?.state === "ready" &&
      !d.cells.get(session.cellId)?.paused &&
      !d.killSwitch.isBusy(session.cellId),
    desktop: upload,
    manual,
    home: d.home,
    harness,
    ...(auth && installer ? { chatgpt: { account: auth, installer, availability: platform } } : {}),
    redactUserText: (text, id, cellId) =>
      forText(
        id ? runner.get(id) : undefined,
        cellId ?? (id ? runner.get(id)?.cellId : undefined),
      )(text),
    appendTo: (id, type, data) => {
      d.eventLog.append(id, { type, agent: "main", data } as never);
    },
  };
  let server: ReturnType<typeof serve> | undefined,
    startPromise: Promise<void> | undefined,
    closePromise: Promise<void> | undefined;
  return {
    runner,
    routes,
    // Legacy scripted tasks share the same client/transfer owner and pre-recording boundary.
    // Unlike agent tasks, they have no AgentSession whose runner can contain a lost reply.
    async prepareDesktopTask(cellId: string, sessionId: string, signal: AbortSignal) {
      try {
        await prepareDesktop(cellId, sessionId, signal);
      } catch (error) {
        failedPreparations.add(cellId);
        d.fences?.capture(cellId, sessionId, "api");
        await d.killSwitch.stopSession(sessionId).catch(() => undefined);
        throw error;
      }
    },
    reservedPorts(): Iterable<number> {
      if (!ready || closing) throw new CellControlConflict("agent cleanup is still in progress");
      return brains.reservedPorts();
    },
    start(): Promise<void> {
      if (startPromise) return startPromise;
      if (closing) return Promise.reject(new Error("agent is closed"));
      startPromise = (async () => {
        await brains.sweep();
        if (closing) throw new Error("agent is closed");
        if (installer) {
          try {
            await installer.verifiedInstallation(new AbortController().signal);
          } catch (error) {
            if (!(error instanceof CodexInstallError)) throw error;
          }
          if (closing) throw new Error("agent is closed");
        }
        await new Promise<void>((resolve, reject) => {
          server = serve(
            { fetch: toolApp.fetch, hostname: "127.0.0.1", port: d.toolPort ?? TOOL_API_PORT },
            () => {
              server?.off("error", reject);
              resolve();
            },
          );
          server.once("error", reject);
        });
        if (closing) {
          server?.close();
          throw new Error("agent is closed");
        }
        ready = true;
      })();
      return startPromise;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      ready = false;
      unsubscribe();
      transfers.close();
      installer?.cancel();
      const authClosed = auth?.close();
      const containments = [...runner.sessions.values()].map((session) =>
        runner.contain(session, "shutdown"),
      );
      const activeClients = [...clients.values()];
      clients.clear();
      closePromise = (async () => {
        const closeListener = async () => {
          // A sweep/listen already in flight still belongs to this lifecycle.
          await startPromise?.catch(() => {});
          if (server?.listening)
            await new Promise<void>((resolve, reject) => {
              server?.close((error) => (error ? reject(error) : resolve()));
            });
        };
        const outcomes = await Promise.allSettled([
          closeListener(),
          transfers.settled(),
          authClosed,
          ...[...installWork].map((work) =>
            work.catch((error) => {
              if (!(error instanceof CodexInstallError && error.code === "cancelled")) throw error;
            }),
          ),
          ...containments,
          runner.close(),
          judgeCell.close(),
          ...activeClients.map((tools) => tools.close()),
          ...retiring,
        ]);
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new Error("agent shutdown cleanup could not be confirmed");
      })();
      return closePromise;
    },
  };
}
