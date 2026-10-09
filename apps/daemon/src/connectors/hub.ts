import {
  type ConnectorConfig,
  type ConnectorDraft,
  type ConnectorPatch,
  type ConnectorStatus,
  type ConnectorToolSpec,
  type ConnectorView,
  connectorHost,
  connectorIdFor,
  connectorToolDescription,
  connectorToolName,
  type KeydRecord,
  MAX_CONNECTOR_TOOLS,
  MAX_CONNECTORS,
  MAX_TASK_CONNECTOR_TOOLS,
  sanitizeToolSchema,
  sanitizeToolText,
  type ToolAccessView,
  toolAccess,
} from "@localdot/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { withIntent } from "./intent.ts";
import { ConnectorProblem } from "./problem.ts";
import { type CachedTool, type ConnectorStore, MAX_LISTED_TOOLS, type ToolCache } from "./store.ts";

export interface OpenLink {
  readonly transport: Transport;
  close(): Promise<void>;
  // What the program said on its way out, for a local connector.
  stderr?(): string;
}
export interface ConnectorLinks {
  open(config: ConnectorConfig, signal: AbortSignal): Promise<OpenLink>;
}

export interface ConnectorHubDeps {
  store: ConnectorStore;
  links: ConnectorLinks;
  // The keys keyd holds, to tell a connector whose key is missing.
  keys(): Promise<readonly KeydRecord[]>;
  now?(): number;
  idleMs?: number;
  connectMs?: number;
  callMs?: number;
}

// One connector tool as a task sees it: dot's name for it, whose it is, and how it is checked.
export interface TaskConnectorTool {
  readonly exposed: string;
  readonly connectorId: string;
  readonly app: string;
  readonly tool: string;
  // The host its arguments go to, when the connector says.
  readonly host?: string;
  readonly spec: ConnectorToolSpec;
  readonly schema: Record<string, unknown>;
}
export interface TaskConnectors {
  readonly specs: readonly ConnectorToolSpec[];
  get(name: string): TaskConnectorTool | undefined;
}
export const NO_CONNECTORS: TaskConnectors = Object.freeze({ specs: [], get: () => undefined });

export interface CallOutcome {
  readonly ok: boolean;
  readonly text: string;
}

const IDLE_MS = 5 * 60_000;
const CONNECT_MS = 120_000;
const CALL_MS = 120_000;
const RESULT_CHARS = 24_000;

interface Live {
  status?: ConnectorStatus;
  problem?: string;
  link?: Promise<{ client: Client; open: OpenLink }>;
  calls: number;
  idle?: ReturnType<typeof setTimeout>;
}

function plainProblem(error: unknown, config: ConnectorConfig, stderr?: string): ConnectorProblem {
  if (error instanceof ConnectorProblem) return error;
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 401 || code === 403 || /\b(?:401|403)\b|unauthori[sz]ed/i.test(message)) {
    const oauth = config.server.kind === "remote" && config.server.auth.kind === "oauth";
    return oauth
      ? new ConnectorProblem("needs_sign_in", "Sign in again to use this app.")
      : new ConnectorProblem("needs_key", "The app didn't accept the key. Add a new one.");
  }
  if (config.server.kind === "local") {
    const said = sanitizeToolText(stderr?.split("\n").filter(Boolean).at(-1), 160);
    return new ConnectorProblem(
      "failed",
      said ? `The app stopped: ${said}` : "The app didn't start. Check its command.",
    );
  }
  if (/abort|timed? ?out/i.test(message))
    return new ConnectorProblem("failed", "The app took too long to answer.");
  return new ConnectorProblem("failed", "Couldn't reach the app. Check its address.");
}

// What an app's result says, as text for dot: its text parts, a resource's text, a note for media.
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const raw of Array.isArray(result.content) ? result.content : []) {
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "resource") {
      const resource = part.resource as Record<string, unknown> | undefined;
      if (typeof resource?.text === "string") parts.push(resource.text);
      else parts.push(`[a file: ${String(resource?.uri ?? "")}]`);
    } else if (part.type === "resource_link")
      parts.push(`[a link: ${String(part.name ?? "")} ${String(part.uri ?? "")}]`);
    else if (part.type === "image") parts.push("[an image]");
    else if (part.type === "audio") parts.push("[an audio clip]");
  }
  if (!parts.length && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n");
  const chars = [...text];
  return chars.length <= RESULT_CHARS
    ? text
    : `${chars.slice(0, RESULT_CHARS).join("")}\n… (${chars.length - RESULT_CHARS} more characters cut)`;
}

function cachedTool(raw: Record<string, unknown>): CachedTool | undefined {
  if (typeof raw.name !== "string" || !raw.name || raw.name.length > 128) return undefined;
  const hints = (raw.annotations ?? {}) as Record<string, unknown>;
  const title = sanitizeToolText(raw.title ?? hints.title, 80);
  return {
    name: raw.name,
    ...(title ? { title } : {}),
    description: sanitizeToolText(raw.description, 600),
    inputSchema: sanitizeToolSchema(raw.inputSchema),
    ...(typeof hints.readOnlyHint === "boolean" || typeof hints.destructiveHint === "boolean"
      ? {
          annotations: {
            ...(typeof hints.readOnlyHint === "boolean"
              ? { readOnlyHint: hints.readOnlyHint }
              : {}),
            ...(typeof hints.destructiveHint === "boolean"
              ? { destructiveHint: hints.destructiveHint }
              : {}),
          },
        }
      : {}),
  };
}

// The user's connectors: their settings, their tools as last listed, and a connection to each
// while it is in use. Every call a task makes reaches its app through here.
export class ConnectorHub {
  readonly #live = new Map<string, Live>();
  #tools: ToolCache;
  readonly #validator = new AjvJsonSchemaValidator();
  constructor(private readonly deps: ConnectorHubDeps) {
    this.#tools = deps.store.tools();
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  #state(id: string): Live {
    let live = this.#live.get(id);
    if (!live) {
      live = { calls: 0 };
      this.#live.set(id, live);
    }
    return live;
  }
  configs(): ConnectorConfig[] {
    return this.deps.store.list();
  }
  config(id: string): ConnectorConfig | undefined {
    return this.configs().find((c) => c.id === id);
  }

  async views(): Promise<ConnectorView[]> {
    const keys = await this.deps.keys().catch(() => undefined);
    return this.configs().map((config) => this.#view(config, keys));
  }
  async view(id: string): Promise<ConnectorView | undefined> {
    return (await this.views()).find((view) => view.id === id);
  }
  #missing(
    config: ConnectorConfig,
    keys: readonly KeydRecord[] | undefined,
  ): ConnectorProblem | undefined {
    if (!keys) return undefined;
    const has = (id: string) => keys.some((key) => key.id === id && !key.reenter && !key.rebound);
    const { server } = config;
    if (server.kind === "remote") {
      if (server.auth.kind === "oauth" && (!server.auth.secret || !has(server.auth.secret)))
        return new ConnectorProblem("needs_sign_in", "Sign in to use this app.");
      if (server.auth.kind === "key" && !has(server.auth.secret))
        return new ConnectorProblem("needs_key", "Add the app's key.");
      return undefined;
    }
    return server.env.some((env) => env.secret && !has(env.secret))
      ? new ConnectorProblem("needs_key", "Add the app's key.")
      : undefined;
  }
  #view(config: ConnectorConfig, keys: readonly KeydRecord[] | undefined): ConnectorView {
    const live = this.#live.get(config.id);
    const missing = config.enabled ? this.#missing(config, keys) : undefined;
    const listed = this.#tools[config.id];
    const status: ConnectorStatus = !config.enabled
      ? "off"
      : (missing?.status ?? live?.status ?? (listed ? "ready" : "connecting"));
    const problem = missing?.message ?? (status === live?.status ? live?.problem : undefined);
    return {
      id: config.id,
      name: config.name,
      ...(config.catalog ? { catalog: config.catalog } : {}),
      enabled: config.enabled,
      server: config.server,
      status,
      ...(problem ? { problem } : {}),
      tools: (listed?.tools ?? []).map((tool) => {
        const choice = config.tools[tool.name];
        const access = toolAccess(tool, choice?.access);
        return {
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: sanitizeToolText(tool.description, 300),
          access: access.access,
          accessFrom: access.from,
          enabled: choice?.enabled !== false,
        };
      }),
      createdAt: config.createdAt,
    };
  }

  add(draft: ConnectorDraft): ConnectorConfig {
    const configs = this.configs();
    if (configs.length >= MAX_CONNECTORS)
      throw new ConnectorProblem("failed", `You can connect up to ${MAX_CONNECTORS} apps.`);
    const taken = new Set(configs.map((c) => c.id));
    if (draft.id && taken.has(draft.id))
      throw new ConnectorProblem("failed", "An app with that name is already connected.");
    const id = draft.id ?? connectorIdFor(draft.catalog ?? draft.name, taken);
    const config: ConnectorConfig = {
      id,
      name: draft.name,
      ...(draft.catalog ? { catalog: draft.catalog } : {}),
      enabled: true,
      server: draft.server,
      tools: {},
      createdAt: this.#now(),
    };
    this.deps.store.save([...configs, config]);
    return config;
  }

  async update(id: string, patch: ConnectorPatch): Promise<ConnectorConfig | undefined> {
    const configs = this.configs();
    const at = configs.findIndex((c) => c.id === id);
    const before = configs[at];
    if (!before) return undefined;
    const tools = { ...before.tools };
    for (const [name, choice] of Object.entries(patch.tools ?? {})) {
      const kept = {
        ...(choice?.enabled === false ? { enabled: false } : {}),
        ...(choice?.access ? { access: choice.access } : {}),
      };
      if (Object.keys(kept).length) tools[name] = kept;
      else delete tools[name];
    }
    const next: ConnectorConfig = {
      ...before,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.server ? { server: patch.server } : {}),
      tools,
    };
    configs[at] = next;
    this.deps.store.save(configs);
    if (patch.server || patch.enabled === false) await this.disconnect(id);
    return next;
  }

  // Records the app's registration of localDot for sign-in.
  setClient(id: string, client: ConnectorConfig["client"]): void {
    const configs = this.configs();
    const at = configs.findIndex((c) => c.id === id);
    const config = configs[at];
    if (!config) return;
    configs[at] = { ...config, ...(client ? { client } : {}) };
    this.deps.store.save(configs);
  }

  async remove(id: string): Promise<ConnectorConfig | undefined> {
    const configs = this.configs();
    const config = configs.find((c) => c.id === id);
    if (!config) return undefined;
    await this.disconnect(id);
    this.deps.store.save(configs.filter((c) => c.id !== id));
    const { [id]: _gone, ...rest } = this.#tools;
    this.#tools = rest;
    this.deps.store.saveTools(this.#tools);
    this.#live.delete(id);
    return config;
  }

  async disconnect(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return;
    clearTimeout(live.idle);
    const link = live.link;
    live.link = undefined;
    live.status = undefined;
    live.problem = undefined;
    const opened = await link?.catch(() => undefined);
    if (opened) {
      await opened.client.close().catch(() => {});
      await opened.open.close().catch(() => {});
    }
  }

  // A saved or removed key ends the stand-ins of every connector that used it.
  async afterKeyChange(secretId: string): Promise<void> {
    for (const config of this.configs()) {
      const { server } = config;
      const uses =
        server.kind === "remote"
          ? server.auth.kind !== "none" && server.auth.secret === secretId
          : server.env.some((env) => env.secret === secretId);
      if (uses) await this.disconnect(config.id);
    }
  }

  #connect(config: ConnectorConfig): Promise<{ client: Client; open: OpenLink }> {
    const live = this.#state(config.id);
    if (live.link) return live.link;
    live.status = "connecting";
    live.problem = undefined;
    const link = (async () => {
      const signal = AbortSignal.timeout(this.deps.connectMs ?? CONNECT_MS);
      const open = await this.deps.links.open(config, signal);
      const client = new Client({ name: "localdot", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(open.transport, {
          signal,
          timeout: this.deps.connectMs ?? CONNECT_MS,
        });
      } catch (error) {
        const stderr = open.stderr?.();
        await open.close().catch(() => {});
        throw plainProblem(error, config, stderr);
      }
      // A program that exits or a server that hangs up is connected again on the next call.
      client.onclose = () => {
        if (live.link !== link) return;
        live.link = undefined;
        void open.close().catch(() => {});
      };
      return { client, open };
    })();
    live.link = link;
    link.catch((error) => {
      if (live.link !== link) return;
      live.link = undefined;
      const problem = plainProblem(error, config);
      live.status = problem.status;
      live.problem = problem.message;
    });
    return link;
  }

  #rest(id: string): void {
    const live = this.#state(id);
    clearTimeout(live.idle);
    if (live.calls > 0) return;
    live.idle = setTimeout(() => void this.disconnect(id), this.deps.idleMs ?? IDLE_MS);
    live.idle.unref?.();
  }

  // Connects and lists the app's tools again; the list is kept for tasks to come.
  async refresh(id: string): Promise<void> {
    const config = this.config(id);
    if (!config?.enabled) return;
    const live = this.#state(id);
    live.calls++;
    try {
      const { client } = await this.#connect(config);
      const listed: CachedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.deps.callMs ?? CALL_MS,
        });
        for (const tool of page.tools) {
          const cached = cachedTool(tool as unknown as Record<string, unknown>);
          if (cached && listed.length < MAX_LISTED_TOOLS) listed.push(cached);
        }
        cursor = page.nextCursor;
      } while (cursor && listed.length < MAX_LISTED_TOOLS);
      this.#tools = { ...this.#tools, [id]: { at: this.#now(), tools: listed } };
      this.deps.store.saveTools(this.#tools);
      live.status = "ready";
      live.problem = undefined;
    } catch (error) {
      const problem = plainProblem(error, config);
      live.status = problem.status;
      live.problem = problem.message;
      await this.disconnect(id).catch(() => {});
      live.status = problem.status;
      live.problem = problem.message;
    } finally {
      live.calls--;
      this.#rest(id);
    }
  }

  // The tools of the enabled connectors as one task sees them, fixed for the task: dot's name for
  // each, the app's sanitized words, and the schema its arguments are checked against.
  forTask(): TaskConnectors {
    let configs: ConnectorConfig[];
    try {
      configs = this.configs();
    } catch {
      return NO_CONNECTORS;
    }
    const byName = new Map<string, TaskConnectorTool>();
    const specs: ConnectorToolSpec[] = [];
    for (const config of configs) {
      if (!config.enabled) continue;
      let shown = 0;
      for (const tool of this.#tools[config.id]?.tools ?? []) {
        if (shown >= MAX_CONNECTOR_TOOLS || specs.length >= MAX_TASK_CONNECTOR_TOOLS) break;
        if (config.tools[tool.name]?.enabled === false) continue;
        const exposed = connectorToolName(config.id, tool.name, new Set(byName.keys()));
        const spec: ConnectorToolSpec = {
          name: exposed,
          app: config.name,
          description: connectorToolDescription(config.name, tool),
          inputSchema: withIntent(tool.inputSchema),
        };
        byName.set(exposed, {
          exposed,
          connectorId: config.id,
          app: config.name,
          tool: tool.name,
          ...(config.server.kind === "remote" ? { host: connectorHost(config.server.url) } : {}),
          spec,
          schema: tool.inputSchema,
        });
        specs.push(spec);
        shown++;
      }
    }
    return Object.freeze({ specs, get: (name: string) => byName.get(name) });
  }

  // What a tool does now: undefined once the user turned it or its app off. The user's latest
  // choice counts, mid-task too.
  access(entry: TaskConnectorTool): ToolAccessView | undefined {
    const config = this.config(entry.connectorId);
    const tool = this.#tools[entry.connectorId]?.tools.find((t) => t.name === entry.tool);
    if (!config?.enabled || !tool || config.tools[entry.tool]?.enabled === false) return undefined;
    return toolAccess(tool, config.tools[entry.tool]?.access);
  }

  // The problem with these arguments, by the schema dot was shown.
  check(entry: TaskConnectorTool, args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args))
      return "The arguments must be an object.";
    try {
      const result = this.#validator.getValidator(entry.schema as never)(args);
      return result.valid ? undefined : sanitizeToolText(result.errorMessage, 300) || "invalid";
    } catch {
      return undefined;
    }
  }

  async call(
    entry: TaskConnectorTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const config = this.config(entry.connectorId);
    if (!config?.enabled) return { ok: false, text: `${entry.app} is turned off.` };
    const live = this.#state(config.id);
    live.calls++;
    clearTimeout(live.idle);
    try {
      const { client } = await this.#connect(config);
      signal.throwIfAborted();
      const result = await client.callTool({ name: entry.tool, arguments: args }, undefined, {
        signal,
        timeout: this.deps.callMs ?? CALL_MS,
      });
      live.status = "ready";
      live.problem = undefined;
      const answer = result as {
        isError?: boolean;
        content?: unknown;
        structuredContent?: unknown;
      };
      return { ok: answer.isError !== true, text: resultText(answer) };
    } catch (error) {
      signal.throwIfAborted();
      // The app answered, with an error of its own: dot reads it and tries another way.
      if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed)
        return {
          ok: false,
          text:
            error.code === ErrorCode.RequestTimeout
              ? "The app took too long to answer."
              : sanitizeToolText(error.message, 500) || "The app refused the call.",
        };
      const problem = plainProblem(error, config);
      if (problem.status !== "failed" || config.server.kind === "local") {
        live.status = problem.status;
        live.problem = problem.message;
        await this.disconnect(config.id).catch(() => {});
        live.status = problem.status;
        live.problem = problem.message;
      }
      return { ok: false, text: problem.message };
    } finally {
      live.calls--;
      this.#rest(config.id);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.disconnect(id)));
  }
}
