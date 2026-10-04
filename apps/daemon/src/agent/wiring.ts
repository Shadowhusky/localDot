import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  CODEX_VERSION,
  CodexInstallError,
  type CodexInstaller,
  type HarnessAvailability,
  harnessAvailability,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
} from "@localdot/codex-harness";
import { type SkillSummary, TOOL_API_PORT } from "@localdot/protocol";
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
import type { KeydMonitor } from "../keyd/monitor.ts";
import { BrainCells, imagesWithBrain } from "./brain-cell.ts";
import { CatalogStore } from "./catalog-store.ts";
import { CodexAuthOwner } from "./codex/auth-owner.ts";
import { CodexDriver } from "./codex/driver.ts";
import { codexInstructions } from "./codex/instructions.ts";
import { openMcpEndpoint } from "./codex/mcp-endpoint.ts";
import { FramePng } from "./frame-png.ts";
import type { ManualDesktop } from "./manual-input.ts";
import { MemoryStore } from "./memory.ts";
import { OutputStore } from "./output-store.ts";
import type { ToolPolicy } from "./policy.ts";
import { redactor } from "./redact.ts";
import type { AgentRoutesDeps, UploadAccess } from "./routes.ts";
import { AgentError, AgentRunner } from "./runner.ts";
import type { AgentSession } from "./session.ts";
import { SettingsStore } from "./settings.ts";
import { listSkills, skillDesktopPath, skillFiles } from "./skills.ts";
import { createToolApi } from "./tool-api.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";
import { TranscriptStore } from "./transcript.ts";
import { type TransferLease, Transfers } from "./transfers.ts";
export interface AgentWiringDeps {
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
}
const CODEX_ACCEPTANCE_PENDING =
  "The ChatGPT plan is awaiting pinned privacy and native safety checks.";
export const BUILTIN_SKILLS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "skills",
);
export function createAgent(d: AgentWiringDeps) {
  const memory = new MemoryStore(d.home),
    settings = new SettingsStore(d.home),
    catalog = new CatalogStore(d.home);
  const transcripts = new TranscriptStore(d.home),
    png = new FramePng(d.frames),
    outputs = new OutputStore(d.home),
    transfers = new Transfers();
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
  const unsubscribe = d.cells.subscribe((cell) => {
    const prior = clients.get(cell.id),
      endpoint = d.cells.endpoints(cell.id)?.desktopd;
    if (
      cell.state !== "ready" ||
      cell.paused ||
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
    if (!d.codex)
      return { available: false, reason: "The ChatGPT plan is not set up in this daemon." };
    if (!roots) return { available: false, reason: "The ChatGPT storage could not be validated." };
    if (closing) return { available: false, reason: "The ChatGPT account service is closed." };
    return harnessAvailability();
  };
  const harness = (): HarnessAvailability => {
    const availability = platform();
    // Tasks13/14 must supply the pinned privacy/protocol and native acceptance evidence
    // before this gate changes. Neither installation nor an environment flag opens it.
    return availability.available
      ? { available: false, reason: CODEX_ACCEPTANCE_PENDING }
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
      gateway: d.gateway,
      scaleOf: (id) => d.cells.get(id)?.scale,
      desktop,
      launcher: (id) => d.registry.for(id)?.client,
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
            const endpoint = d.cells.endpoints(session.cellId)?.desktopd;
            const check = () => {
              lease.check();
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
              check();
              const frame = await d.gateway.observe({
                sessionId: session.id,
                cellId: session.cellId,
                signal: lease.signal,
              });
              check();
              const full = await png.png(session.id, frame.frameId, undefined, lease.signal);
              check();
              session.tainted = true;
              session.lastFrameId = frame.frameId;
              return { frameId: frame.frameId, full: true, png: full };
            } finally {
              lease.finish();
            }
          },
          instructions: (session) =>
            codexInstructions({
              memory: memory.readBoth(),
              skills: runner.skillsOf(session.id),
              today: new Date(),
            }),
          redactorFor: (session) => forText(session),
          waitForAuthResume: (session) => runner.waitForAuthResume(session),
        })
      : undefined;
  const runner = new AgentRunner({
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
    installSkills,
    waitForUploads: (id, signal) => transfers.wait(id, signal),
    stopSession: (id) => d.killSwitch.stopSession(id),
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
  const manual = (session: AgentSession): ManualDesktop | undefined => {
    const cell = d.cells.get(session.cellId);
    if (!cell) throw new AgentError(404, "the computer is unavailable");
    const target = d.registry.for(session.cellId);
    if (!target) return undefined;
    const endpoint = target.client.endpoint;
    const check = () => {
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
        current.scale !== cell.scale ||
        d.killSwitch.isBusy(session.cellId) ||
        now?.baseUrl !== endpoint.baseUrl ||
        now.token !== endpoint.token
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
    return {
      screen: { w: 1280 * cell.scale, h: 800 * cell.scale },
      client: target.client,
      check,
      prepare: async () => {
        if (!target.clocks.sample) await target.clocks.sync();
      },
      release: unsubscribe,
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
    runner,
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
