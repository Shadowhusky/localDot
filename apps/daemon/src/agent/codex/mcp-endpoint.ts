import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  assertOwnedCodexDirectory,
  type CodexTurnEpoch,
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  removeOwnedCodexDirectory,
} from "@localdot/codex-harness";
import {
  MAX_BATCH_STEPS,
  type PauseSnapshot,
  type ToolResult,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentSession, BrainGeneration } from "../session.ts";
import {
  codexTools,
  connectorDescriptors,
  type McpCallResult,
  toCallToolResult,
} from "./mcp-tools.ts";
export const MAX_MCP_CONNECTIONS = 4;
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SOCKET_PATH_BYTES = 103;
const MAX_PENDING = 8;
const FRAME_PATTERN = new RegExp(ULID_PATTERN);
const decoder = new TextDecoder("utf-8", { fatal: true });
const failResult = (): McpCallResult => ({
  isError: true,
  content: [{ type: "text", text: "This Codex turn is no longer active." }],
});
export class McpEndpointError extends Error {
  constructor() {
    super("The localDot Codex tool bridge could not be opened.");
    this.name = "McpEndpointError";
  }
}
export interface McpCallContext {
  readonly generation: BrainGeneration;
  readonly authGeneration: number;
  readonly turnEpoch: CodexTurnEpoch;
  readonly basisFrameId: string;
  readonly connection: object;
  readonly requestId: number | string;
  readonly signal: AbortSignal;
}
export type McpDispatch = (
  tool: string,
  callId: string,
  input: unknown,
  context: McpCallContext,
) => Promise<{ status: number; result: ToolResult }>;
export interface McpEndpointInput {
  readonly roots: OwnedCodexRoots;
  readonly session: AgentSession;
  readonly generation: BrainGeneration;
  readonly authGeneration: number;
  readonly currentAuthGeneration: () => number;
  readonly authSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly dispatch: McpDispatch;
  readonly onResult?: (tool: string, result: ToolResult, context: McpCallContext) => void;
  readonly onRetire?: (reason: "stale" | "done" | "cancelled" | "failure") => void;
}
export interface McpPauseReceipt {
  readonly generation: BrainGeneration;
  readonly authGeneration: number;
  readonly epoch: CodexTurnEpoch | undefined;
  readonly requestId: string;
  readonly revision: number;
  readonly callsSettled: true;
  readonly resultOwnershipConfirmed: true;
  readonly completedCalls: number;
}
export interface McpEndpoint {
  readonly dir: string;
  readonly directory: OwnedCodexDirectory;
  readonly socket: string;
  setTurn(epoch: CodexTurnEpoch): void;
  retireTurn(epoch: CodexTurnEpoch): void;
  pauseAtBoundary(
    epoch: CodexTurnEpoch | undefined,
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
  ): Promise<McpPauseReceipt>;
  validatePauseReceipt(receipt: McpPauseReceipt): boolean;
  connections(): number;
  close(): Promise<void>;
}
interface Connection {
  readonly identity: object;
  readonly abort: AbortController;
  readonly socket: Socket;
  readonly calls: Map<number | string, McpCallContext>;
  readonly requests: Set<number | string>;
  transport?: PrivateMcpTransport;
  mcp?: Server;
  closed: boolean;
}
// Use the SDK server with a bounded, guarded socket transport. Its stock stdio adapter does not
// capture authority at wire admission or recheck it immediately before an asynchronous reply.
class PrivateMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #buffer: Buffer = Buffer.alloc(0);
  #bytes = 0;
  #closed = false;
  readonly #data = (chunk: Buffer) => this.#read(chunk);
  readonly #error = () => this.#drop();
  readonly #ended = () => {
    void this.close();
  };
  constructor(
    readonly connection: Connection,
    readonly admit: (msg: JSONRPCMessage) => boolean,
    readonly guard: (ctx: McpCallContext) => boolean,
    readonly retire: () => void,
    readonly sent: (capture: McpCallContext) => void,
  ) {}
  async start(): Promise<void> {
    if (this.#closed || this.connection.closed) throw new McpEndpointError();
    this.connection.socket
      .on("data", this.#data)
      .on("error", this.#error)
      .on("end", this.#ended)
      .on("close", this.#ended);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#bytes = 0;
    this.connection.socket
      .off("data", this.#data)
      .off("error", this.#error)
      .off("end", this.#ended)
      .off("close", this.#ended);
    this.retire();
    this.onclose?.();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed || this.connection.closed || this.connection.socket.destroyed)
      throw new McpEndpointError();
    const id = "id" in message ? message.id : undefined;
    const capture = id === undefined ? undefined : this.connection.calls.get(id);
    let safe: JSONRPCMessage = message;
    if ("error" in message)
      safe = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: message.error.code,
          message: "The Codex tool request could not be completed.",
        },
      };
    if (capture && !this.guard(capture))
      safe = {
        jsonrpc: "2.0",
        id: capture.requestId,
        error: { code: -32000, message: "This Codex turn is no longer active." },
      };
    // All serialization happens before the final authority check. A late success/image becomes
    // a fixed refusal, never a screenshot obtained after retirement or a hand-back.
    let line = `${JSON.stringify(safe)}\n`;
    if (capture && !this.guard(capture))
      line = `${JSON.stringify({ jsonrpc: "2.0", id: capture.requestId, error: { code: -32000, message: "This Codex turn is no longer active." } })}\n`;
    if (this.connection.closed || this.connection.socket.destroyed) throw new McpEndpointError();
    if (
      Buffer.byteLength(line) > 16 * 1024 * 1024 ||
      this.connection.socket.writableLength + Buffer.byteLength(line) > 16 * 1024 * 1024
    )
      throw new McpEndpointError();
    await new Promise<void>((resolve, reject) => {
      this.connection.socket.write(line, (error) =>
        error ? reject(new McpEndpointError()) : resolve(),
      );
    });
    if (id !== undefined) {
      if (capture) this.sent(capture);
      this.connection.requests.delete(id);
      this.connection.calls.delete(id);
    }
  }
  refuse(id: number | string): void {
    void this.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "This Codex turn is no longer active." },
    }).catch(() => this.#drop());
  }
  #drop(): void {
    this.onerror?.(new McpEndpointError());
    void this.close().catch(() => {});
  }
  #read(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      const end = chunk.indexOf(10, offset),
        last = end < 0 ? chunk.length : end,
        size = last - offset;
      if (this.#bytes + size > MAX_MCP_MESSAGE_BYTES) {
        this.#drop();
        return;
      }
      if (this.#buffer.length < this.#bytes + size) {
        const grown = Buffer.allocUnsafe(
          Math.min(
            MAX_MCP_MESSAGE_BYTES,
            Math.max(4096, this.#bytes + size, this.#buffer.length * 2),
          ),
        );
        this.#buffer.copy(grown, 0, 0, this.#bytes);
        this.#buffer = grown;
      }
      chunk.copy(this.#buffer, this.#bytes, offset, last);
      this.#bytes += size;
      if (end < 0) return;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(
          JSON.parse(decoder.decode(this.#buffer.subarray(0, this.#bytes))),
        );
      } catch {
        this.#drop();
        return;
      }
      this.#bytes = 0;
      if (this.admit(message)) this.onmessage?.(message);
      offset = end + 1;
    }
  }
}
export async function openMcpEndpoint(input: McpEndpointInput): Promise<McpEndpoint> {
  const lifetime = new AbortController(),
    signal = AbortSignal.any([
      input.signal,
      input.authSignal,
      input.generation.signal,
      input.session.abort.signal,
      lifetime.signal,
    ]);
  let directory: OwnedCodexDirectory | undefined,
    server: ReturnType<typeof createServer> | undefined,
    closed: Promise<void> | undefined;
  let ended = false,
    usedTurn = false,
    turn: CodexTurnEpoch | undefined,
    turnSnapshot: { id: number; signal: AbortSignal; basis: string } | undefined,
    turnAbort: AbortController | undefined;
  let queue: Promise<unknown> = Promise.resolve(),
    pending = 0;
  const connections = new Set<Connection>();
  const owners = new WeakMap<object, Connection>();
  const callOwnership = new WeakMap<
    McpCallContext,
    {
      started: boolean;
      released: boolean;
      dispatched: boolean;
      resultOwned: boolean;
      replied: boolean;
    }
  >();
  const captures = new Set<McpCallContext>();
  let pausedAdmission = false,
    uncertain = false,
    completedCalls = 0;
  let pauseReceipt: McpPauseReceipt | undefined;
  const wakes = new Set<() => void>();
  const wake = () => {
    for (const notify of [...wakes]) notify();
  };
  const forget = (capture: McpCallContext) => {
    const record = callOwnership.get(capture);
    if (record?.released && (record.replied || !record.dispatched)) captures.delete(capture);
    wake();
  };
  const release = (capture: McpCallContext) => {
    const record = callOwnership.get(capture);
    if (!record || record.released) return;
    record.released = true;
    pending--;
    if (record.dispatched && !record.resultOwned) uncertain = true;
    forget(capture);
  };
  const validOwner = () => {
    try {
      return (
        !ended &&
        !signal.aborted &&
        input.session.isCurrent(input.generation) &&
        !input.session.controlHeld &&
        input.currentAuthGeneration() === input.authGeneration
      );
    } catch {
      return false;
    }
  };
  const current = (capture: McpCallContext) =>
    validOwner() &&
    !capture.signal.aborted &&
    owners.get(capture.connection)?.closed === false &&
    turn === capture.turnEpoch &&
    turnSnapshot?.id === capture.turnEpoch.id &&
    turnSnapshot.signal === capture.turnEpoch.signal &&
    turnSnapshot.basis === capture.basisFrameId;
  const retireTurn = (epoch: CodexTurnEpoch) => {
    if (turn !== epoch) return;
    turn = undefined;
    turnSnapshot = undefined;
    turnAbort?.abort();
  };
  const notifyRetire = (reason: "stale" | "done" | "cancelled" | "failure") => {
    try {
      Promise.resolve(input.onRetire?.(reason)).catch(() => {});
    } catch {
      /* failure cannot reopen admission */
    }
  };
  const retireConnection = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true;
    connection.abort.abort();
    for (const capture of connection.calls.values()) {
      const record = callOwnership.get(capture);
      if (record?.dispatched && !record.replied) uncertain = true;
      if (!record?.started) release(capture);
    }
    wake();
    connections.delete(connection);
    connection.socket.destroy();
    void connection.mcp?.close().catch(() => {});
  };
  const close = (): Promise<void> => {
    if (closed) return closed;
    let resolve!: () => void, reject!: (error: Error) => void;
    closed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    ended = true;
    if (turn) retireTurn(turn);
    lifetime.abort();
    for (const connection of [...connections]) retireConnection(connection);
    void (async () => {
      if (server)
        await new Promise<void>((yes, no) => {
          const timer = setTimeout(() => no(new McpEndpointError()), 2000);
          server?.close((error) => {
            clearTimeout(timer);
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
              no(new McpEndpointError());
            else yes();
          });
        });
      if (directory) await removeOwnedCodexDirectory(directory);
      signal.removeEventListener("abort", aborted);
    })().then(resolve, () => reject(new McpEndpointError()));
    return closed;
  };
  const aborted = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    if (!validOwner() || !Number.isSafeInteger(input.authGeneration) || input.authGeneration < 0)
      throw new McpEndpointError();
    directory = createOwnedCodexDirectory(input.roots, "runRoot");
    const socket = join(directory.path, "m.sock");
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) throw new McpEndpointError();
    const run = (capture: McpCallContext, name: string, args: unknown): Promise<McpCallResult> => {
      const record = callOwnership.get(capture);
      if (record) record.started = true;
      const operation = queue
        .then(async () => {
          if (!current(capture)) return failResult();
          // Wire-admitted queued work owns no tool lease. A safety hold cannot start it.
          if (pausedAdmission || input.session.safetyPause)
            return toCallToolResult({
              ok: false,
              pause: true,
              content: [{ type: "text", text: "Task paused before this call started." }],
            });
          const steps = (args as { steps?: unknown } | null)?.steps;
          if (name === "computer" && Array.isArray(steps) && steps.length > MAX_BATCH_STEPS)
            return toCallToolResult({
              ok: false,
              content: [
                {
                  type: "text",
                  text: `A batch takes at most ${MAX_BATCH_STEPS} steps; split it in two.`,
                },
              ],
            });
          if (record) record.dispatched = true;
          let toolInput = args;
          if (
            (name === "computer" || name === "browser_act") &&
            typeof args === "object" &&
            args !== null &&
            !Array.isArray(args)
          ) {
            const { basedOn: _ignored, ...rest } = args as Record<string, unknown>;
            toolInput = { ...rest, basedOn: capture.basisFrameId };
          }
          const out = await input.dispatch(name, `codex-${ulid()}`, toolInput, capture);
          if (!current(capture)) return failResult();
          if (out.result.cancelled === "stale") {
            retireTurn(capture.turnEpoch);
            notifyRetire("stale");
            return failResult();
          }
          const reported: unknown = input.onResult?.(name, out.result, capture);
          if (
            reported !== null &&
            (typeof reported === "object" || typeof reported === "function") &&
            typeof (reported as { then?: unknown }).then === "function"
          ) {
            Promise.resolve(reported).catch(() => {});
            retireTurn(capture.turnEpoch);
            notifyRetire("failure");
            return failResult();
          }
          if (!current(capture)) return failResult();
          if (out.result.final && !input.session.safetyPause) {
            retireTurn(capture.turnEpoch);
            notifyRetire("done");
            return failResult();
          }
          const result = toCallToolResult(out.result);
          if (record) record.resultOwned = true;
          completedCalls++;
          return result;
        })
        .catch(() => {
          retireTurn(capture.turnEpoch);
          notifyRetire("failure");
          return failResult();
        })
        .finally(() => {
          release(capture);
        });
      queue = operation;
      return new Promise<McpCallResult>((resolve) => {
        const abort = () => {
          capture.signal.removeEventListener("abort", abort);
          resolve(failResult());
        };
        capture.signal.addEventListener("abort", abort, { once: true });
        operation.then(
          (result) => {
            capture.signal.removeEventListener("abort", abort);
            resolve(result);
          },
          () => abort(),
        );
        if (capture.signal.aborted) abort();
      });
    };
    server = createServer((sock) => {
      // Error ownership precedes all MCP awaits, including a refused connection.
      sock.on("error", () => {});
      if (!validOwner() || connections.size >= MAX_MCP_CONNECTIONS) {
        sock.destroy();
        return;
      }
      const connection: Connection = {
        identity: Object.freeze({}),
        abort: new AbortController(),
        socket: sock,
        calls: new Map(),
        requests: new Set(),
        closed: false,
      };
      connections.add(connection);
      owners.set(connection.identity, connection);
      sock.once("close", () => retireConnection(connection));
      const mcp = new Server(
        { name: "localdot", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      connection.mcp = mcp;
      const transport = new PrivateMcpTransport(
        connection,
        (message) => {
          if (!validOwner() || connection.closed) {
            retireConnection(connection);
            return false;
          }
          if ("method" in message && message.method === "notifications/cancelled") {
            const params = message.params as { requestId?: number | string } | undefined,
              capture =
                params?.requestId === undefined
                  ? undefined
                  : connection.calls.get(params.requestId);
            if (capture) {
              retireTurn(capture.turnEpoch);
              notifyRetire("cancelled");
            }
          }
          if (!("method" in message) || !("id" in message)) return true;
          if (connection.requests.has(message.id) || connection.requests.size >= 64) {
            retireConnection(connection);
            return false;
          }
          connection.requests.add(message.id);
          if (message.method !== "tools/call") return true;
          if (
            pausedAdmission ||
            input.session.safetyPause ||
            !turn ||
            turn.signal.aborted ||
            !turnSnapshot ||
            pending >= MAX_PENDING
          ) {
            transport.refuse(message.id);
            return false;
          }
          const captureSignal = AbortSignal.any([
            signal,
            connection.abort.signal,
            turn.signal,
            turnAbort?.signal ?? signal,
          ]);
          const capture: McpCallContext = Object.freeze({
            generation: input.generation,
            authGeneration: input.authGeneration,
            turnEpoch: turn,
            basisFrameId: turnSnapshot.basis,
            connection: connection.identity,
            requestId: message.id,
            signal: captureSignal,
          });
          callOwnership.set(capture, {
            started: false,
            released: false,
            dispatched: false,
            resultOwned: false,
            replied: false,
          });
          captures.add(capture);
          connection.calls.set(message.id, capture);
          pending++;
          return true;
        },
        current,
        () => retireConnection(connection),
        (capture) => {
          const record = callOwnership.get(capture);
          if (record) record.replied = true;
          if (!record?.started) release(capture);
          forget(capture);
        },
      );
      connection.transport = transport;
      transport.onerror = () => retireConnection(connection);
      mcp.onerror = () => retireConnection(connection);
      mcp.setRequestHandler(ListToolsRequestSchema, () => {
        if (!validOwner() || connection.closed) throw new McpEndpointError();
        return {
          tools: [
            ...codexTools(undefined, !!input.session.research),
            ...connectorDescriptors(input.session.connectors),
          ],
        };
      });
      mcp.setRequestHandler(CallToolRequestSchema, (req, extra) => {
        const capture = connection.calls.get(extra.requestId);
        if (!capture) return failResult();
        // SDK cancellation is also part of admission. Transport handles ID zero, which the pinned
        // SDK's truthiness check otherwise ignores, before forwarding the cancellation.
        const cancellation = () => {
          retireTurn(capture.turnEpoch);
        };
        extra.signal.addEventListener("abort", cancellation, { once: true });
        return run(capture, req.params.name, req.params.arguments ?? {}).finally(() =>
          extra.signal.removeEventListener("abort", cancellation),
        );
      });
      void mcp.connect(transport).catch(() => retireConnection(connection));
    });
    server.on("error", () => {
      if (turn) retireTurn(turn);
      notifyRetire("failure");
      void close().catch(() => {});
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new McpEndpointError());
      signal.addEventListener("abort", abort, { once: true });
      server?.once("listening", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      server?.listen({ path: socket, signal });
    });
    if (!validOwner()) throw new McpEndpointError();
    assertOwnedCodexDirectory(input.roots, directory, "runRoot");
    const entry = lstatSync(socket);
    if (!entry.isSocket() || entry.uid !== process.getuid?.()) throw new McpEndpointError();
    chmodSync(socket, 0o600);
    const pauseCurrent = (
      epoch: CodexTurnEpoch | undefined,
      pause: Pick<PauseSnapshot, "requestId" | "revision">,
    ) =>
      validOwner() &&
      turn === epoch &&
      input.session.safetyPause?.requestId === pause.requestId &&
      input.session.safetyPause.revision === pause.revision;
    const validatePauseReceipt = (receipt: McpPauseReceipt): boolean =>
      receipt === pauseReceipt &&
      pausedAdmission &&
      !uncertain &&
      pending === 0 &&
      captures.size === 0 &&
      pauseCurrent(receipt.epoch, receipt);
    const pauseAtBoundary = async (
      epoch: CodexTurnEpoch | undefined,
      pause: Pick<PauseSnapshot, "requestId" | "revision">,
    ): Promise<McpPauseReceipt> => {
      // This private marker is synchronous; future wire requests are refused without cancelling active dispatch.
      if (!pauseCurrent(epoch, pause)) throw new McpEndpointError();
      pausedAdmission = true;
      await input.session.safetyBoundary(signal);
      const deadline = Date.now() + 2000;
      while (pending || captures.size) {
        if (!pauseCurrent(epoch, pause) || uncertain || Date.now() >= deadline)
          throw new McpEndpointError();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wakes.delete(done);
            resolve();
          };
          const timer = setTimeout(done, 10);
          wakes.add(done);
        });
      }
      if (!pauseCurrent(epoch, pause) || uncertain) throw new McpEndpointError();
      pauseReceipt = Object.freeze({
        generation: input.generation,
        authGeneration: input.authGeneration,
        epoch,
        requestId: pause.requestId,
        revision: pause.revision,
        callsSettled: true as const,
        resultOwnershipConfirmed: true as const,
        completedCalls,
      });
      return pauseReceipt;
    };
    return Object.freeze({
      dir: directory.path,
      directory,
      socket,
      connections: () => connections.size,
      close: () => close().finally(() => signal.removeEventListener("abort", aborted)),
      retireTurn,
      pauseAtBoundary,
      validatePauseReceipt,
      setTurn: (epoch: CodexTurnEpoch) => {
        if (
          !validOwner() ||
          usedTurn ||
          !Object.isFrozen(epoch) ||
          !Number.isSafeInteger(epoch.id) ||
          epoch.id <= 0 ||
          !(epoch.signal instanceof AbortSignal) ||
          epoch.signal.aborted ||
          !FRAME_PATTERN.test(epoch.basisFrameId)
        )
          throw new McpEndpointError();
        if (!directory) throw new McpEndpointError();
        assertOwnedCodexDirectory(input.roots, directory, "runRoot");
        usedTurn = true;
        turn = epoch;
        turnSnapshot = { id: epoch.id, signal: epoch.signal, basis: epoch.basisFrameId };
        turnAbort = new AbortController();
      },
    });
  } catch {
    signal.removeEventListener("abort", aborted);
    await close().catch(() => {});
    throw new McpEndpointError();
  }
}
