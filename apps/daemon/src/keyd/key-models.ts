import { AgentRoleChoice, type KeydRecord, ulid } from "@localdot/protocol";
import { gatewayBaseURL } from "@localdot/providers";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { cappedText, ModelAnswerError } from "../agent/safety/judge-model.ts";
import type { KeydClient } from "./client.ts";

const CELL = "key-models";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 500;
// keyd prices every route a listener holds. Reading a list generates nothing, so this is never spent.
const NOTHING = { id: "model-list", inputUSDPerMTok: 1, outputUSDPerMTok: 1, maxOutputTokens: 1 };

interface Deps {
  keyd: Pick<
    KeydClient,
    | "openCell"
    | "closeCell"
    | "beginPricedTask"
    | "endTask"
    | "modelAdmission"
    | "setModelAdmission"
  >;
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
}

export interface KeyModel {
  id: string;
  name?: string;
}

// The usual shapes of a provider's list, whichever a server follows: `data` as OpenAI and Anthropic
// have it, `models` as Gemini and Ollama do.
export function listedModels(reply: unknown): KeyModel[] {
  const { data, models } = (reply ?? {}) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(data) ? data : Array.isArray(models) ? models : [];
  const found = new Map<string, KeyModel>();
  for (const row of rows as { id?: unknown; name?: unknown; display_name?: unknown }[]) {
    const raw = typeof row === "string" ? row : (row?.id ?? row?.name);
    if (typeof raw !== "string") continue;
    const id = raw.replace(/^models\//, "");
    if (!AgentRoleChoice.shape.model.safeParse(id).success) continue;
    const name = typeof row === "object" ? (row.display_name ?? row.name) : undefined;
    found.set(id, {
      id,
      ...(typeof name === "string" && name !== raw ? { name: name.slice(0, 128) } : {}),
    });
    if (found.size === MAX_MODELS) break;
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// A key's own list of models, read through a short-lived listener that holds only that key, so the
// key itself never leaves keyd. Reads take turns on the one listener.
export class KeyModels {
  #turn: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: Deps) {}
  list(key: KeydRecord, signal: AbortSignal): Promise<KeyModel[]> {
    const read = this.#turn.then(() => this.#read(key, signal));
    this.#turn = read.catch(() => {});
    return read;
  }
  async #read(key: KeydRecord, signal: AbortSignal): Promise<KeyModel[]> {
    signal.throwIfAborted();
    const { keyd } = this.deps;
    const port = this.deps.ports.reserve();
    let agent: ProxyAgent | undefined;
    let opened = false;
    try {
      await keyd.closeCell(CELL).catch(() => false);
      const cell = await keyd.openCell({ cellId: CELL, role: "brain", port, secrets: [key.id] });
      opened = true;
      if (cell.port !== port) throw new Error("keyd did not open the model list's listener");
      const taskId = ulid();
      await keyd.beginPricedTask(CELL, taskId, {
        v: 1,
        routes: [{ route: key.id, models: [NOTHING] }],
      });
      const owner = await keyd.modelAdmission(CELL);
      if (owner.taskId !== taskId || owner.retired) throw new Error("listener owner changed");
      const open = await keyd.setModelAdmission(CELL, {
        taskId,
        generationId: owner.generationId,
        expectedEpoch: owner.epoch,
        state: "open",
      });
      if (open.taskId !== taskId || open.paused || open.retired)
        throw new Error("listener admission was not opened");
      signal.throwIfAborted();
      agent = new ProxyAgent({
        uri: `http://127.0.0.1:${port}`,
        token: `Basic ${Buffer.from(`catalog:${cell.proxyToken}`).toString("base64")}`,
        proxyTunnel: false,
      });
      const surrogate = cell.surrogates?.[key.id] ?? "";
      const reply = await (this.deps.fetch ?? undiciFetch)(`${gatewayBaseURL(key.id)}/models`, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(key.provider === "anthropic"
            ? { "x-api-key": surrogate, "anthropic-version": "2023-06-01" }
            : key.provider === "google"
              ? { "x-goog-api-key": surrogate }
              : key.provider === "azure"
                ? { "api-key": surrogate }
                : { authorization: `Bearer ${surrogate}` }),
        },
        dispatcher: agent,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!reply.ok) {
        await reply.body?.cancel().catch(() => {});
        throw new ModelAnswerError(reply.status, "");
      }
      return listedModels(JSON.parse(await cappedText(reply, MAX_BYTES)));
    } finally {
      if (opened) {
        await keyd.endTask(CELL).catch(() => {});
        await keyd.closeCell(CELL).catch(() => false);
      }
      await agent?.close().catch(() => {});
      this.deps.ports.release(port);
    }
  }
}
