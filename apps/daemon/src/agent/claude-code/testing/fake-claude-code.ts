import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  kill(signal: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
}

// One mocked Claude Code process: the SDK's query, its prompt stream and its MCP connection. As
// the real SDK does, it starts the process before query() returns.
export class FakeRun {
  readonly prompts: SDKUserMessage[] = [];
  readonly child: FakeChild;
  readonly #queue: unknown[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  closed = false;
  #mcp: Client | undefined;
  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const message of prompt) this.prompts.push(message);
    })();
    this.child = options.spawnClaudeCodeProcess?.({
      command: options.pathToClaudeCodeExecutable ?? "",
      args: [],
      cwd: options.cwd,
      env: options.env ?? {},
      signal: new AbortController().signal,
    }) as unknown as FakeChild;
  }
  readonly query = {
    close: () => {
      this.closed = true;
      this.child.kill("SIGTERM");
      this.end();
    },
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        for (;;) {
          if (this.#queue.length) return { done: false, value: this.#queue.shift() };
          if (this.#ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
      },
    }),
  };
  emit(...messages: unknown[]): void {
    this.#queue.push(...messages);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async mcp(): Promise<Client> {
    if (this.#mcp) return this.#mcp;
    const server = this.options.mcpServers?.localdot;
    if (server?.type !== "sdk" || !("instance" in server)) throw new Error("no server");
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(transport);
    this.#mcp = new Client({ name: "fixture", version: "1.0.0" });
    await this.#mcp.connect(client);
    return this.#mcp;
  }
  async call(name: string, args: Record<string, unknown>) {
    return (await this.mcp()).callTool({ name, arguments: args });
  }
}
