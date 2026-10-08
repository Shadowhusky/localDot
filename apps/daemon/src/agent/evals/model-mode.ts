import {
  type AgentLimits,
  DEFAULT_AGENT_LIMITS,
  ModelBinding,
  type SecretBinding,
  sealSecret,
  TaskPricing,
  ulid,
} from "@localdot/protocol";
import { languageModel } from "../../../../../cells/brain/src/models.ts";
import { proxyFetch } from "../../../../../cells/brain/src/proxy-fetch.ts";
import type { KeydClient } from "../../keyd/client.ts";
import type { Prices } from "./report.ts";
import type { ModelSession } from "./suite.ts";

type Env = (name: string) => string | undefined;

const CLIENTS = {
  lmstudio: { computer: "generic", coords: "per1000", keyEnv: undefined },
  ollama: { computer: "generic", coords: "per1000", keyEnv: undefined },
  anthropic: { computer: "anthropic-toolset", coords: "pixels", keyEnv: "ANTHROPIC_API_KEY" },
  openai: { computer: "generic", coords: "pixels", keyEnv: "OPENAI_API_KEY" },
  google: { computer: "generic", coords: "per1000", keyEnv: "GEMINI_API_KEY" },
} as const;
type Client = keyof typeof CLIENTS;
const MAX_CAP_USD = 100;

export class ModelModeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelModeRefused";
  }
}

export interface ModelModeConfig {
  label: string;
  client: Client;
  binding: ModelBinding;
  pricing: TaskPricing;
  prices: Prices;
  capUSD: number;
  keyEnv?: string;
}

const decimal = (value: string | undefined) =>
  value !== undefined && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : Number.NaN;

// Model mode is opt-in twice over: a model binding and a spend cap, both explicit. A local model
// (LM Studio, Ollama) is the default way to use it; a paid model needs its own prices and key.
export function modelModeConfig(env: Env): ModelModeConfig | undefined {
  const selected = env("LOCALDOT_EVAL_MODEL");
  if (!selected) return undefined;
  const cap = decimal(env("LOCALDOT_EVAL_SPEND_CAP_USD"));
  if (!(cap > 0 && cap <= MAX_CAP_USD))
    throw new ModelModeRefused(
      `model mode needs LOCALDOT_EVAL_SPEND_CAP_USD, a dollar amount above 0 and at most ${MAX_CAP_USD}`,
    );
  const split = selected.indexOf(":");
  const client = selected.slice(0, split) as Client;
  const model = selected.slice(split + 1);
  if (split < 1 || !Object.hasOwn(CLIENTS, client) || !model)
    throw new ModelModeRefused(
      `LOCALDOT_EVAL_MODEL must be <client>:<model> with a client of ${Object.keys(CLIENTS).join(", ")}`,
    );
  const spec = CLIENTS[client];
  const local = spec.keyEnv === undefined;
  const prices = {
    inputUSDPerMTok: local ? 0 : decimal(env("LOCALDOT_EVAL_INPUT_USD_PER_MTOK")),
    outputUSDPerMTok: local ? 0 : decimal(env("LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK")),
  };
  if (!local && !(prices.inputUSDPerMTok >= 0 && prices.outputUSDPerMTok > 0))
    throw new ModelModeRefused(
      "a paid model needs LOCALDOT_EVAL_INPUT_USD_PER_MTOK and LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK",
    );
  const coords = env("LOCALDOT_EVAL_COORDS") ?? spec.coords;
  const binding = ModelBinding.safeParse({
    route: client,
    client,
    model,
    computer: spec.computer,
    coords,
    vision: true,
    reasoning: env("LOCALDOT_EVAL_REASONING") === "1",
    contextTokens: 128_000,
    maxOutputTokens: 4096,
  });
  const pricing = TaskPricing.safeParse({
    v: 1,
    routes: [{ route: client, models: [{ id: model, ...prices, maxOutputTokens: 4096 }] }],
  });
  if (!binding.success || !pricing.success)
    throw new ModelModeRefused("the model binding or its prices are invalid");
  return {
    label: selected,
    client,
    binding: binding.data,
    pricing: pricing.data,
    prices,
    capUSD: cap,
    ...(spec.keyEnv ? { keyEnv: spec.keyEnv } : {}),
  };
}

type ModelKeyd = Pick<
  KeydClient,
  "status" | "putSecret" | "openCell" | "beginPricedTask" | "endTask" | "closeCell"
>;

// keyd owns the spend: each task gets its own brain listener and a task budget equal to what is
// left of the cap, so keyd refuses the model call that would cross it.
export function keydModelMode(config: ModelModeConfig, keyd: ModelKeyd, port: number, env: Env) {
  const secret = config.keyEnv
    ? ({ id: `eval-${config.client}`, kind: "llm", provider: config.client } as SecretBinding)
    : undefined;
  let sealed = false;
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, maxTurns: 60 };
  return {
    label: config.label,
    prices: config.prices,
    capUSD: config.capUSD,
    limits,
    async begin(budgetUSD: number): Promise<ModelSession> {
      if (secret && !sealed) {
        const value = env(config.keyEnv as string);
        if (!value) throw new ModelModeRefused(`${config.keyEnv} is required for ${config.label}`);
        await keyd.putSecret(
          secret,
          await sealSecret((await keyd.status()).sealKey, secret, value),
        );
        sealed = true;
      }
      const cellId = ulid();
      const opened = await keyd.openCell({
        cellId,
        role: "brain",
        port,
        secrets: secret ? [secret.id] : [],
      });
      const transport = proxyFetch(`http://127.0.0.1:${opened.port}`, opened.proxyToken);
      try {
        await keyd.beginPricedTask(cellId, ulid(), config.pricing, budgetUSD);
        const binding = ModelBinding.parse({
          ...config.binding,
          ...(secret ? { surrogate: opened.surrogates?.[secret.id] } : {}),
        });
        return {
          under: {
            binding,
            model: languageModel(binding, transport),
            proxy: { url: `http://127.0.0.1:${opened.port}`, token: opened.proxyToken },
          },
          end: async () => {
            await Promise.allSettled([transport.close(), keyd.endTask(cellId)]);
            await keyd.closeCell(cellId);
          },
        };
      } catch (error) {
        await transport.close().catch(() => {});
        await keyd.closeCell(cellId).catch(() => {});
        throw error;
      }
    },
  };
}
export type KeydModelMode = ReturnType<typeof keydModelMode>;
