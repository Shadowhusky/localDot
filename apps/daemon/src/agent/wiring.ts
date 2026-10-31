import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  query as claudeQuery,
  type Query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { createAdaptorServer, serve } from "@hono/node-server";
import {
  CHATGPT_INSTALL_FIRST,
  CHATGPT_SWITCHED_OFF,
  CODEX_VERSION,
  CodexInstallError,
  type CodexInstaller,
  checkHost,
  checkNativeSandbox,
  codexReleased,
  type HarnessAvailability,
  harnessAvailability,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
  readLocalAcceptance,
  writeLocalAcceptance,
} from "@localdot/codex-harness";
import {
  CLAUDE_CODE_MODEL,
  type PersonaId,
  type SkillSummary,
  TOOL_API_PORT,
} from "@localdot/protocol";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import type { BrowserScope } from "../browser/client.ts";
import { releaseForFullAccess } from "../browser/full-access-downloads.ts";
import { desktopPlacement } from "../browser/placement.ts";
import type { QuarantineStore } from "../browser/quarantine.ts";
import { quarantineAccess } from "../browser/quarantine-access.ts";
import { releaseDownload } from "../browser/quarantine-routes.ts";
import type { ScreenLease } from "../browser/screen-controller.ts";
import type { SessionScreens } from "../browser/session-screens.ts";
import type { DockerClient } from "../cells/docker.ts";
import { CellControlConflict, type CellOrchestrator } from "../cells/orchestrator.ts";
import type { PortRange } from "../cells/ports.ts";
import { type GateRelay, listenOnSocket } from "../cells/relay.ts";
import { ConnectorCells, connectorImages } from "../connectors/cell.ts";
import { ConnectorHub } from "../connectors/hub.ts";
import { CellAndRemoteLinks } from "../connectors/links.ts";
import { ConnectorSignIn } from "../connectors/oauth.ts";
import { RemoteLinks } from "../connectors/remote.ts";
import { ConnectorStore } from "../connectors/store.ts";
import type { ComputerAccess } from "../deliverables/convert.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "../gateway/frames.ts";
import type { ActionGateway } from "../gateway/gateway.ts";
import type { KillSwitch } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { KeydClient } from "../keyd/client.ts";
import { JudgeCell } from "../keyd/judge-cell.ts";
import { ModelCatalog } from "../keyd/model-catalog.ts";
import type { KeydMonitor } from "../keyd/monitor.ts";
import { QuickModel } from "../keyd/quick-model.ts";
import { ServiceKeys } from "../keyd/service-keys.ts";
import { runtimeLayout } from "../runtime-layout.ts";
import { BrainCells, imagesWithBrain } from "./brain-cell.ts";
import { CatalogStore } from "./catalog-store.ts";
import { claudeCodeAnswer } from "./claude-code/answer.ts";
import { ClaudeCodeCleanupError, ClaudeCodeDriver } from "./claude-code/driver.ts";
import { claudeCodeInstructions } from "./claude-code/instructions.ts";
import { localdotServer } from "./claude-code/mcp-server.ts";
import { claudeCodeOptions } from "./claude-code/options.ts";
import {
  type ClaudeCodeLaunch,
  type ClaudeCodeModel,
  ClaudeCodeSetup,
  ClaudeCodeUnavailable,
  findClaudeCode,
  runFile,
} from "./claude-code/setup.ts";
import { claudePlanUsage } from "./claude-code/usage.ts";
import { CodexAuthOwner } from "./codex/auth-owner.ts";
import { CodexDriver } from "./codex/driver.ts";
import { codexInstructions } from "./codex/instructions.ts";
import { openMcpEndpoint } from "./codex/mcp-endpoint.ts";
import { ChatgptSetup, SANDBOX_REASONS, SETUP_UNSAVED } from "./codex/setup.ts";
import { ComputerTurns } from "./computer-turn.ts";
import { Conversations } from "./conversation.ts";
import { ExperienceRecorder } from "./experience-recorder.ts";
import { FramePng } from "./frame-png.ts";
import type { ManualDesktop } from "./manual-input.ts";
import { MemoryStore } from "./memory.ts";
import { OutputStore } from "./output-store.ts";
import { PeopleStore } from "./people.ts";
import { PlanUsageStore } from "./plan-usage.ts";
import type { ToolPolicy } from "./policy.ts";
import { PrivateFiles } from "./private-files.ts";
import { RecentActivity } from "./recent-activity.ts";
import { redactor } from "./redact.ts";
import type { AgentRoutesDeps, UploadAccess } from "./routes.ts";
import { AgentError, AgentRunner, type AgentRunnerDeps } from "./runner.ts";
import { ConnectionApprovals } from "./safety/connections.ts";
import { NativeTasks } from "./safety/native-tasks.ts";
import { PurposeService } from "./safety/purpose-service.ts";
import { RulesStore } from "./safety/rules.ts";
import { taintMemory } from "./safety/taint.ts";
import type { AgentSession, BrainGeneration } from "./session.ts";
import { SettingsStore } from "./settings.ts";
import { leftoverSkills, listSkills, skillDesktopPath, skillFiles, skillsFor } from "./skills.ts";
import { createToolApi } from "./tool-api.ts";
import type { ToolDeps } from "./tools/deps.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";
import type { RoutineToolPort } from "./tools/routine.ts";
import { TranscriptStore } from "./transcript.ts";
import { type TransferLease, Transfers } from "./transfers.ts";
import { UserUploads } from "./user-uploads.ts";
import { WebCell } from "./web/cell.ts";
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
  killSwitch: Pick<KillSwitch, "contain" | "isBusy">;
  // Remembers the computers a service stop froze, so the next start thaws them.
  shutdownFreezes?: Pick<import("../cells/shutdown-freezes.ts").ShutdownFreezes, "record">;
  keydPorts: PortRange;
  policy?: ToolPolicy;
  routines?: RoutineToolPort;
  toolPort?: number;
  // Also serves the tool API here, for brain gates on Docker Engine (cells/relay.ts).
  toolSocket?: string;
  relay?: () => Promise<GateRelay>;
  codex?: { realHome: string; user: string };
  claudeCode?: { realHome: string };
  sessionScreens?: Pick<SessionScreens, "install" | "bind" | "manual" | "startBrowser"> &
    Partial<Pick<SessionScreens, "workEndpoint">>;
  transfers?: Transfers;
  quarantine?: QuarantineStore;
  // Earlier tasks for the recall tool, from the search index.
  recall?: ToolDeps["recall"];
  notesChanged?(file: string): void;
  liveChanged?: AgentRunnerDeps["liveChanged"];
}
export const BUILTIN_SKILLS = runtimeLayout.skills;
// A native harness hands memory to the model here.
function tainting<T extends { user: string; memory: string }>(session: AgentSession, memory: T): T {
  taintMemory(session.taint, memory);
  return memory;
}

export function createAgent(d: AgentWiringDeps) {
  const memory = new MemoryStore(d.home),
    people = new PeopleStore(d.home),
    settings = new SettingsStore(d.home),
    catalog = new CatalogStore(d.home, {
      enrich: (next, previous, signal) => modelCatalog.enrich(next, previous, signal),
    });
  const recentActivity = new RecentActivity({
    log: d.eventLog,
    isLive: (id) => d.live.cellOf(id) !== undefined,
  });
  const conversations = new Conversations(d.home, d.eventLog);
  const experience = new ExperienceRecorder({
    memory,
    allowed: (id) => {
      const session = runner.get(id);
      return (
        !!session &&
        !session.stopped &&
        (session.permissionMode() === "full" ||
          session.autonomy.memory === "act" ||
          session.taskAutonomy.relaxes("memory", {}))
      );
    },
    changed: (id, change) => {
      runner.get(id)?.append("memory.change", {
        file: change.file,
        patch: change.patch,
        changeId: change.changeId,
      });
      d.notesChanged?.(change.file);
    },
  });
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
        d.live.cellOf(sessionId) !== cellId ||
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
    ...(d.relay ? { relay: d.relay } : {}),
  });
  const modelCatalog = new ModelCatalog({
    keyd: d.keyd,
    ports: { reserve: () => brains.reservePort(), release: (port) => brains.releasePort(port) },
  });
  const judgeCell = new JudgeCell({
    keyd: d.keyd,
    ports: { reserve: () => brains.reservePort(), release: (port) => brains.releasePort(port) },
  });
  const quickModel = new QuickModel({
    keyd: d.keyd,
    ports: { reserve: () => brains.reservePort(), release: (port) => brains.releasePort(port) },
  });
  const purposeService = new PurposeService({
    keys: () => d.keyd.secrets(),
    settings: () => settings.get(),
    post: (key, body, signal) => judgeCell.post(key, body, signal),
  });
  const connectorPorts = {
    reserve: () => brains.reservePort(),
    release: (port: number) => brains.releasePort(port),
  };
  const remoteLinks = new RemoteLinks({ keyd: d.keyd, ports: connectorPorts });
  const serviceKeys = new ServiceKeys({ keyd: d.keyd, ports: connectorPorts });
  const webCell = new WebCell({ keyd: d.keyd, ports: connectorPorts });
  const connectorCells = new ConnectorCells({
    docker: d.docker,
    keyd: d.keyd,
    ports: connectorPorts,
    images: connectorImages(),
    home: d.home,
    ...(d.relay ? { relay: d.relay } : {}),
  });
  const connectors = new ConnectorHub({
    store: new ConnectorStore(d.home),
    links: new CellAndRemoteLinks({ remote: remoteLinks, cells: connectorCells }),
    keys: () => d.keyd.secrets(),
  });
  const connectorSignIn = new ConnectorSignIn({
    hub: connectors,
    keyd: d.keyd,
    fetchFor: (id) => remoteLinks.signIn(id),
  });
  const skills = () => listSkills(BUILTIN_SKILLS, join(d.home, "skills"));
  const installSkills = async (
    cellId: string,
    signal: AbortSignal,
    persona?: PersonaId,
  ): Promise<SkillSummary[]> => {
    signal.throwIfAborted();
    const tools = desktop(cellId);
    if (!tools) throw new AgentError(409, "the computer is not ready");
    const chosen = skillsFor(persona, skills());
    // Built-in skills an earlier task's dot left behind go, so this dot carries only its own; a
    // computer that can't list or remove them still starts the task.
    try {
      const present = await tools.listDir(".skills", signal);
      for (const name of leftoverSkills(
        present.entries.filter((entry) => entry.type === "dir").map((entry) => entry.name),
        chosen,
      )) {
        signal.throwIfAborted();
        await tools.shell(
          { command: `rm -rf -- ~/.skills/${name}`, timeoutMs: 10_000 },
          () => {},
          signal,
        );
      }
    } catch {
      signal.throwIfAborted();
    }
    const installed: SkillSummary[] = [];
    for (const skill of chosen) {
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
  // Whether the plan can be chosen and set up here. Tasks also need this Mac's own stamps.
  const harness = (): HarnessAvailability => {
    const availability = platform();
    return availability.available && !codexReleased()
      ? { available: false, reason: CHATGPT_SWITCHED_OFF }
      : availability;
  };
  let setup: ChatgptSetup | undefined;
  const auth = roots
    ? new CodexAuthOwner({
        roots,
        sessions: () =>
          [...runner.sessions.values()].filter((session) => runner.isChatgpt(session.id)),
        taskDenyRead: (id) => runner.codexDenyReadOf(id),
        pauseForAuth: (session, generation) => runner.pauseForAuth(session, generation),
        sandboxReason: () => (setup ? setup.reason() : SANDBOX_REASONS.unchecked),
      })
    : undefined;
  if (auth && roots) {
    const owned = roots;
    setup = new ChatgptSetup({
      installer: auth.installer,
      host: checkHost,
      check: (installed, signal) => checkNativeSandbox({ roots: owned, installed, signal }),
      read: () => readLocalAcceptance(owned),
      write: (record) => writeLocalAcceptance(owned, record),
    });
  }
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
  const turns = new ComputerTurns({
    live: d.live,
    windows: (id) => {
      const client = d.registry.for(id)?.client;
      return client?.windows ? (request, signal) => client.windows(request, signal) : undefined;
    },
  });
  const dispatch: DispatchDeps = {
    ...(d.policy ? { policy: d.policy } : {}),
    tools: {
      saveExperience: (id, lesson) => experience.save(id, lesson),
      recallExperience: (query, id) => memory.recallMemory(query, id),
      uploads: { desktop, transfers },
      gateway: d.gateway,
      computer: turns,
      bindScreen: d.sessionScreens?.bind.bind(d.sessionScreens),
      logins: d.keyd,
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
      people,
      ...(d.recall
        ? {
            recall: (query: string, limit: number, exclude: string) => {
              let remaining = 6000;
              return (d.recall?.(query, limit, exclude) ?? []).map((hit) => {
                if (!hit.sessionId || hit.sessionId === exclude || remaining <= 0) return hit;
                let context = "";
                try {
                  context = conversations
                    .taskContext(hit.sessionId)
                    .slice(0, Math.min(3000, remaining));
                } catch {
                  // An unreadable old log must not discard the other search results.
                }
                remaining -= context.length;
                return { ...hit, context };
              });
            },
          }
        : {}),
      saveOutput: (id, name, source, scope) => outputs.save(id, name, source, scope),
      stopForUncertainty: (session, reason, why) => runner.contain(session, reason, why),
      sleep: (ms, signal) => sleep(ms, undefined, { signal }),
      ...(d.routines ? { routines: d.routines } : {}),
      connectors,
      web: webCell,
      credentials: serviceKeys,
    },
  };
  // A native harness's first look at the task computer: one full screenshot of the selected screen.
  const observe = async (
    session: AgentSession,
    generation: BrainGeneration,
    signal: AbortSignal,
  ) => {
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
      if (screen) await session.screens?.refreshBrowser(screen);
      const binding = screen ? d.sessionScreens?.bind(session, screen) : undefined;
      if (screen && !binding) throw new AgentError(409, "The selected screen is unavailable.");
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
      session.taintScreen(screen?.selection.screen ?? "desktop");
      session.lastFrameId = frame.frameId;
      session.freshLook();
      return { frameId: frame.frameId, full: true as const, png: full };
    } finally {
      screen?.finish();
      lease.finish();
    }
  };
  const nativeTasks = new NativeTasks(d.home);
  const nativeRetired = (sessionId: string) => {
    try {
      nativeTasks.confirmed(sessionId);
    } catch {
      throw new ClaudeCodeCleanupError();
    }
    for (const record of d.fences?.records() ?? [])
      if (record.sessionId === sessionId && record.executor === "native")
        d.fences?.confirmNativeRetirement(record.cellId, sessionId);
  };
  const driver =
    auth && roots
      ? new CodexDriver({
          onRetired: nativeRetired,
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
          observe,
          instructions: (session) =>
            codexInstructions({
              memory: tainting(session, memory.bootMemory(session.task)),
              recent: session.recent,
              skills: runner.skillsOf(session.id),
              today: new Date(),
              ...(session.run ? { run: session.run } : {}),
              ...(session.research ? { research: session.research.budget } : {}),
              apps: session.connectors.specs.map((spec) => spec.app),
              role: runner.roleOf(session.id),
            }),
          redactorFor: (session) => forText(session),
          waitForAuthResume: (session) => runner.waitForAuthResume(session),
        })
      : undefined;
  const spawnClaudeCode = (options: SpawnOptions): SpawnedProcess =>
    spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
  // Starts the user's Claude Code without a prompt, only to ask it something that needs no model.
  const askClaudeCode = async <T>(
    launch: ClaudeCodeLaunch,
    signal: AbortSignal,
    ask: (query: Query) => Promise<T>,
  ): Promise<T> => {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const idle: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
      },
    };
    const query = claudeQuery({
      prompt: idle,
      options: claudeCodeOptions({
        launch,
        instructions: "",
        server: localdotServer(async () => ({ isError: true, content: [] })),
        abort,
        spawn: spawnClaudeCode,
      }),
    });
    const timer = setTimeout(stop, 15_000);
    try {
      return await ask(query);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      query.close();
      stop();
    }
  };
  const claudeModels = (launch: ClaudeCodeLaunch, signal: AbortSignal) =>
    askClaudeCode(
      launch,
      signal,
      async (query): Promise<ClaudeCodeModel[]> =>
        (await query.supportedModels()).map((model) => ({
          id: model.value,
          name: model.displayName,
          ...(model.resolvedModel && CLAUDE_CODE_MODEL.test(model.resolvedModel)
            ? { resolvedModel: model.resolvedModel }
            : {}),
          ...(model.supportedEffortLevels
            ? { efforts: model.supportedEffortLevels }
            : model.supportsEffort === false
              ? { efforts: [] }
              : {}),
          ...(model.supportsFastMode !== undefined ? { fast: model.supportsFastMode } : {}),
        })),
    );
  const claudeHome = d.claudeCode?.realHome;
  const claudeSetup = claudeHome
    ? new ClaudeCodeSetup({
        home: claudeHome,
        workDir: () => new PrivateFiles(d.home).directory("claude-code/work"),
        find: () => findClaudeCode(claudeHome),
        run: runFile,
        env: process.env,
        listModels: claudeModels,
      })
    : undefined;
  // How much of each subscription plan is used, from any task's reports, and read from the plan's
  // own app when the model menu opens: Codex's account read and Claude Code's /usage data, neither
  // of which takes a model turn.
  const planUsage = new PlanUsageStore({
    home: d.home,
    read: {
      ...(auth
        ? {
            chatgpt: async () => {
              const status = await auth.status();
              if (status.state === "signed_out" || status.state === "expired") return "signed_out";
              // A failed check keeps the last figures under a new time, so they are no reading.
              if (status.lastError || !status.usage || status.checkedAt === undefined) return;
              return { usage: status.usage, observedAt: status.checkedAt };
            },
          }
        : {}),
      ...(claudeSetup
        ? {
            "claude-code": async (signal) => {
              let launch: ClaudeCodeLaunch;
              try {
                launch = await claudeSetup.launch();
              } catch (error) {
                if (error instanceof ClaudeCodeUnavailable && error.status.state === "signed_out")
                  return "signed_out";
                throw error;
              }
              const usage = claudePlanUsage(
                await askClaudeCode(launch, signal, (query) =>
                  query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                    skipBehaviors: true,
                  }),
                ),
                launch.plan,
              );
              return usage && { usage, observedAt: Date.now() };
            },
          }
        : {}),
    },
  });
  const stopPlanUsageFeed = d.eventLog.subscribe((_, event) => {
    if (event.type === "subscription.usage") planUsage.record(event.data, Date.now());
  });
  const claudeDriver = claudeSetup
    ? new ClaudeCodeDriver({
        onRetired: nativeRetired,
        query: (params) => claudeQuery(params),
        launch: () => claudeSetup.launch(),
        spawn: (options, session) =>
          nativeTasks.spawn(
            session.cellId,
            session.id,
            () =>
              spawn(options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                detached: true,
                stdio: ["pipe", "pipe", "ignore"],
              }),
            (other) => d.live.cellOf(other) === session.cellId,
          ),
        dispatch: async (session, generation, name, callId, input, signal) =>
          (
            await dispatchTool(
              dispatch,
              session,
              name,
              callId,
              input,
              forText(session),
              generation,
              signal,
            )
          ).result,
        observe,
        transcripts,
        instructions: (session) =>
          claudeCodeInstructions({
            memory: tainting(session, memory.bootMemory(session.task)),
            recent: session.recent,
            skills: runner.skillsOf(session.id),
            today: new Date(),
            ...(session.run ? { run: session.run } : {}),
            ...(session.research ? { research: session.research.budget } : {}),
            apps: session.connectors.specs.map((spec) => spec.app),
            role: runner.roleOf(session.id),
          }),
        redactorFor: (session) => forText(session),
      })
    : undefined;
  const runner = new AgentRunner({
    home: d.home,
    installSession: d.sessionScreens?.install.bind(d.sessionScreens),
    startBrowser: d.sessionScreens?.startBrowser.bind(d.sessionScreens),
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
    connectors: () => connectors.forTask(),
    recentActivity,
    transcripts,
    conversations,
    installSkills,
    prepareDesktop: (session) => prepareDesktop(session.cellId, session.id, session.abort.signal),
    waitForUploads: (id, signal) => transfers.wait(id, signal),
    stopSession: (id) => d.killSwitch.contain(id),
    computer: turns,
    ...(d.liveChanged ? { liveChanged: d.liveChanged } : {}),
    ...(claudeDriver && claudeSetup
      ? {
          claudeCode: {
            driver: claudeDriver,
            status: () => claudeSetup.status(),
            answer: (fast) =>
              claudeCodeAnswer(
                { query: claudeQuery, launch: () => claudeSetup.launch(), spawn: spawnClaudeCode },
                fast,
              ),
          },
        }
      : {}),
    jev: (secretId, body, signal) => purposeService.post(secretId, body, signal),
    quickModel: (role, system, prompt, signal) => quickModel.ask(role, system, prompt, signal),
    ...(driver && auth
      ? {
          codex: {
            driver,
            authGeneration: () => auth.authGeneration,
            account: {
              status: async (opts) => {
                const availability = harness(),
                  reason = !availability.available
                    ? (availability.reason ?? CHATGPT_SWITCHED_OFF)
                    : auth.installer.status().state !== "ready"
                      ? CHATGPT_INSTALL_FIRST
                      : setup?.reason();
                const off = (why: string) => ({
                  available: false,
                  reason: why,
                  codexVersion: CODEX_VERSION,
                  state: "unavailable" as const,
                });
                if (reason || !setup) return off(reason ?? CHATGPT_SWITCHED_OFF);
                const status = await setup.confirm(await auth.status(opts));
                return status.state === "signed_in" && !setup.ready() ? off(SETUP_UNSAVED) : status;
              },
            },
          },
        }
      : {}),
  });
  const forText = (session?: AgentSession, cellId = session?.cellId) => {
    const record = cellId ? d.cells.record(cellId) : undefined;
    return redactor(
      [
        d.installToken,
        session?.toolToken,
        session?.boot?.proxy.token,
        record?.tokens.desktopd,
        record?.tokens.stream,
      ],
      session,
    );
  };
  const upload = (
    cellId: string,
    requestSignal: AbortSignal,
    userOwned = false,
  ): (UploadAccess & { tools: DesktopdTools }) | undefined => {
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
        !userOwned &&
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
    const generation = !userOwned ? session?.generation : undefined;
    const toolLease = session && generation ? session.admit(generation, requestSignal) : undefined;
    let transfer: TransferLease;
    try {
      transfer = transfers.acquire(
        cellId,
        [
          requestSignal,
          ...(toolLease ? [toolLease.signal] : !userOwned && session ? [session.abort.signal] : []),
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
    const unchanged = () => {
      const current = d.cells.get(session.cellId);
      const now = d.cells.endpoints(session.cellId)?.desktopd;
      if (
        closing ||
        !ready ||
        session.stopped ||
        runner.get(session.id) !== session ||
        d.live.cellOf(session.id) !== session.cellId ||
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
    const check = () => {
      scope.check();
      unchanged();
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
          confirm: async () => {
            unchanged();
            if (!access.confirm)
              throw new AgentError(503, "manual browser recovery is unavailable");
            await access.confirm();
            unchanged();
          },
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
      // desktopd's /release waits for the input requests still sending, and its helper takes one
      // command at a time, in order: it answers once everything sent before it has landed.
      confirm: async () => {
        unchanged();
        await target.client.release();
        unchanged();
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
    purpose: purposeService,
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
    notesChanged: d.notesChanged,
    people,
    recentActivity: () => recentActivity.list(),
    sessionInfo: (ids) => d.eventLog.sessionInfo(ids),
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
    uploads: {
      hasCell: (id) => {
        const cell = d.cells.get(id);
        return !!cell && !cell.fenced && !closing;
      },
      store: new UserUploads(d.home, async (cellId, file, source) => {
        // User-owned data transfer is independent of model turns and browser focus. The
        // computer lifecycle still owns the lease, so update/reset/shutdown drain it safely.
        const access = upload(cellId, new AbortController().signal, true);
        if (!access) throw new AgentError(409, "Computer unavailable for file placement");
        try {
          const receipt = await access.tools.putUserFile(file, source, access.signal);
          access.check();
          return receipt;
        } finally {
          access.release();
        }
      }),
    },
    manual,
    desktopPage: async (cellId, signal) => {
      const cell = d.cells.get(cellId);
      if (!ready || closing || cell?.state !== "ready" || cell.paused) return undefined;
      return desktop(cellId)?.browserPage(signal);
    },
    home: d.home,
    harness,
    ...(auth && installer && setup
      ? { chatgpt: { account: auth, installer, availability: platform, setup } }
      : {}),
    ...(claudeSetup ? { claudeCode: claudeSetup } : {}),
    planUsage,
    redactUserText: (text, id, cellId) =>
      forText(
        id ? runner.get(id) : undefined,
        cellId ?? (id ? runner.get(id)?.cellId : undefined),
      )(text),
    appendTo: (id, type, data) => {
      d.eventLog.append(id, { type, agent: "main", data } as never);
    },
  };
  const connections = new ConnectionApprovals({
    keyd: d.keyd,
    task: (cellId) => {
      const live = d.live.get(cellId);
      const session = live ? runner.get(live) : undefined;
      return session && !session.stopped ? session : undefined;
    },
    rules: new RulesStore(d.home),
    owner: async (cellId, port) => {
      const endpoint = d.cells.endpoints(cellId)?.desktopd;
      return endpoint ? new DesktopdClient(endpoint).connectionOwner(port) : undefined;
    },
    cells: () =>
      d.cells
        .list()
        .filter((cell) => cell.state === "ready")
        .map((cell) => cell.id),
  });
  // A computer for one daemon-initiated job (file previews), admitted like a user upload: refused
  // while the user holds control or Stop is running, and aborted by Stop.
  const computerAccess = (
    cellId: string,
    signal: AbortSignal,
  ): ComputerAccess | "busy" | undefined => {
    let access: UploadAccess | undefined;
    try {
      access = upload(cellId, signal);
    } catch (error) {
      if (error instanceof AgentError && error.status === 409) return "busy";
      throw error;
    }
    const tools = access ? desktop(cellId) : undefined;
    if (!access || !tools) {
      access?.release();
      return undefined;
    }
    return { tools, signal: access.signal, check: access.check, release: access.release };
  };
  const stopExperienceFeed = d.eventLog.subscribe((id, event) => {
    experience.event(id, event);
  });
  let server: ReturnType<typeof serve> | undefined,
    socketServer: ReturnType<typeof createAdaptorServer> | undefined,
    startPromise: Promise<void> | undefined,
    closePromise: Promise<void> | undefined;
  const quarantine = routes.quarantine;
  return {
    runner,
    routes,
    connections,
    connectors,
    releaseDownloads(parentCellId: string, items: readonly QuarantineItem[]): void {
      if (!quarantine) return;
      void releaseForFullAccess(
        {
          session: (id) => {
            const live = d.live.get(id);
            return live ? runner.get(live) : undefined;
          },
          release: (parent, id, request, signal) =>
            releaseDownload(quarantine, parent, id, request, signal),
        },
        parentCellId,
        items,
      );
    },
    connectorSignIn,
    computerAccess,
    // Legacy scripted tasks share the same client/transfer owner and pre-recording boundary.
    // Unlike agent tasks, they have no AgentSession whose runner can contain a lost reply.
    async prepareDesktopTask(cellId: string, sessionId: string, signal: AbortSignal) {
      try {
        await prepareDesktop(cellId, sessionId, signal);
      } catch (error) {
        failedPreparations.add(cellId);
        d.fences?.capture(cellId, sessionId, "api");
        await d.killSwitch.contain(sessionId).catch(() => undefined);
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
        // Connector cells an earlier run left end with it.
        await connectorCells.sweep().catch(() => console.error("connector cleanup failed"));
        if (installer) {
          try {
            await installer.verifiedInstallation(new AbortController().signal);
          } catch (error) {
            if (!(error instanceof CodexInstallError)) throw error;
          }
          if (closing) throw new Error("agent is closed");
          // A new pin, macOS build or sandbox runtime is checked again before anything launches.
          if (setup && harness().available && installer.status().state === "ready")
            void tracked(setup.check());
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
        if (d.toolSocket) {
          socketServer = createAdaptorServer({ fetch: toolApp.fetch });
          await listenOnSocket(socketServer, d.toolSocket);
        }
        if (closing) {
          server?.close();
          socketServer?.close();
          throw new Error("agent is closed");
        }
        ready = true;
        // Check provider metadata on every daemon launch without delaying the computer/UI.
        void tracked(catalog.refresh().catch(() => undefined));
      })();
      return startPromise;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      catalog.close();
      ready = false;
      unsubscribe();
      stopExperienceFeed();
      stopPlanUsageFeed();
      planUsage.close();
      transfers.close();
      installer?.cancel();
      claudeSetup?.close();
      const setupClosed = setup?.close();
      const authClosed = auth?.close();
      const containments = [...runner.sessions.values()].map((session) =>
        runner.stopForShutdown(session).then(() => session.cellId),
      );
      const frozen = Promise.allSettled(containments).then((results) => {
        try {
          d.shutdownFreezes?.record(
            results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
          );
        } catch {
          console.error("frozen computers could not be remembered for the next start");
        }
      });
      const activeClients = [...clients.values()];
      clients.clear();
      closePromise = (async () => {
        const closeListener = async () => {
          // A sweep/listen already in flight still belongs to this lifecycle.
          await startPromise?.catch(() => {});
          for (const listener of [server, socketServer])
            if (listener?.listening)
              await new Promise<void>((resolve, reject) => {
                listener.close((error) => (error ? reject(error) : resolve()));
              });
        };
        const outcomes = await Promise.allSettled([
          closeListener(),
          transfers.settled(),
          setupClosed,
          authClosed,
          ...[...installWork].map((work) =>
            work.catch((error) => {
              if (!(error instanceof CodexInstallError && error.code === "cancelled")) throw error;
            }),
          ),
          ...containments,
          frozen,
          runner.close(),
          judgeCell.close(),
          webCell.close(),
          serviceKeys.close(),
          connectors.close(),
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
