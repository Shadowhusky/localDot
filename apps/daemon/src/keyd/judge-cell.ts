import { JEV_HOST, JEV_PATH, type KeydOpened } from "@localdot/protocol";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { cappedText } from "../agent/safety/judge-model.ts";
import type { KeydClient } from "./client.ts";

export const JUDGE_CELL_ID = "purpose-judge";
const IDLE_MS = 5 * 60_000;
const MAX_REPLY_BYTES = 64 * 1024;

export interface JudgeCellDeps {
  keyd: Pick<KeydClient, "openCell" | "closeCell">;
  // A keyd listener port no computer or brain uses, and its return.
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
  idleMs?: number;
}
interface Open {
  readonly secretId: string;
  readonly port: number;
  readonly surrogate: string;
  readonly agent: ProxyAgent;
}

// The daemon's own keyd listener for Jev: it holds only the Jev key's stand-in and reaches only
// Jev's host, where keyd swaps in the real key, as it does for every provider key. It opens on the
// first question and closes after a quiet spell, giving its port back.
export class JudgeCell {
  #open: Promise<Open> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly deps: JudgeCellDeps) {}
  async post(secretId: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const cell = await this.#cell(secretId);
    signal.throwIfAborted();
    this.#rest();
    let reply: Response;
    try {
      reply = await (this.deps.fetch ?? undiciFetch)(`https://${JEV_HOST}${JEV_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${cell.surrogate}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        dispatcher: cell.agent,
        redirect: "error",
        signal,
      });
    } catch (error) {
      // A listener keyd closed or lost answers nothing; the next question opens a fresh one.
      if (!signal.aborted) await this.close();
      throw error;
    }
    if (!reply.ok) {
      await reply.body?.cancel().catch(() => {});
      // A replaced or removed key ends its stand-in; the next question opens a fresh listener.
      if ([401, 403, 407].includes(reply.status)) await this.close();
      throw new Error(`Jev answered ${reply.status}`);
    }
    return JSON.parse(await cappedText(reply, MAX_REPLY_BYTES));
  }
  #cell(secretId: string): Promise<Open> {
    const current = this.#open;
    if (current)
      return current.then((cell) =>
        cell.secretId === secretId ? cell : this.close().then(() => this.#cell(secretId)),
      );
    const opening = this.#start(secretId);
    this.#open = opening;
    opening.catch(() => {
      if (this.#open === opening) this.#open = undefined;
    });
    return opening;
  }
  async #start(secretId: string): Promise<Open> {
    // A listener left by an earlier run of the daemon holds a stand-in nobody has any more.
    await this.deps.keyd.closeCell(JUDGE_CELL_ID).catch(() => false);
    const port = this.deps.ports.reserve();
    let opened: KeydOpened;
    try {
      opened = await this.deps.keyd.openCell({
        cellId: JUDGE_CELL_ID,
        role: "judge",
        port,
        secrets: [secretId],
      });
    } catch (error) {
      this.deps.ports.release(port);
      throw error;
    }
    const surrogate = opened.surrogates?.[secretId];
    if (!surrogate || opened.port !== port) {
      await this.deps.keyd.closeCell(JUDGE_CELL_ID).catch(() => false);
      this.deps.ports.release(port);
      throw new Error("keyd did not open the judge listener as asked");
    }
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${port}`,
      token: `Basic ${Buffer.from(`judge:${opened.proxyToken}`).toString("base64")}`,
      requestTls: { ca: opened.caCertPem, servername: JEV_HOST },
    });
    this.#rest();
    return { secretId, port, surrogate, agent };
  }
  #rest(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.close(), this.deps.idleMs ?? IDLE_MS);
    this.#idle.unref?.();
  }
  async close(): Promise<void> {
    clearTimeout(this.#idle);
    const opening = this.#open;
    this.#open = undefined;
    const cell = await opening?.catch(() => undefined);
    if (!cell) return;
    await cell.agent.close().catch(() => {});
    await this.deps.keyd.closeCell(JUDGE_CELL_ID).catch(() => false);
    this.deps.ports.release(cell.port);
  }
}
