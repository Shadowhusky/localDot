import { type KeydRecord, SURROGATE_PATTERN, ulid } from "@localdot/protocol";
import {
  applyProviderMetadata,
  type Catalog,
  gatewayBaseURL,
  keydRouteModel,
  PROVIDERS,
} from "@localdot/providers";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { cappedText } from "../agent/safety/judge-model.ts";
import type { KeydClient } from "./client.ts";

const CELL = "model-catalog";
const MAX_BYTES = 8 * 1024 * 1024;
interface Deps {
  keyd: Pick<
    KeydClient,
    | "secrets"
    | "openCell"
    | "closeCell"
    | "beginPricedTask"
    | "endTask"
    | "modelAdmission"
    | "setModelAdmission"
  >;
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
  now?: () => Date;
}
// Short-lived metadata-only GETs through keyd. No real key enters the daemon, model context,
// disk cache or logs. Dedicated listener/task cannot interrupt a user's agent or spend tokens.
export class ModelCatalog {
  constructor(private readonly deps: Deps) {}
  async enrich(
    catalog: Catalog,
    previous: Catalog | undefined,
    signal: AbortSignal,
  ): Promise<Catalog> {
    // Preserve the last verified controls per model through partial outages; never replace
    // live task snapshots, request destinations, prices or auth from capability data.
    for (const [provider, p] of Object.entries(catalog.providers))
      for (const m of Object.values(p.models)) {
        const old = previous?.providers[provider]?.models[m.id];
        if (old?.controls) {
          m.controls = old.controls;
          m.controlsCheckedAt = old.controlsCheckedAt;
        }
      }
    let keys: KeydRecord[];
    try {
      keys = await this.deps.keyd.secrets();
    } catch {
      return catalog;
    }
    const routes = PROVIDERS.filter((p) => !p.local && !p.custom && !p.notOffered && !p.availableIn)
      .flatMap((p) => {
        const key = keys.find(
          (key) =>
            key.kind === "llm" &&
            key.provider === p.keyd &&
            (!p.baseURL || key.baseURL?.replace(/\/+$/, "") === p.baseURL.replace(/\/+$/, "")),
        );
        return key ? [{ provider: p.id, key }] : [];
      })
      .slice(0, 32);
    if (!routes.length || signal.aborted) return catalog;
    // One bounded immutable pricing owner per batch; metadata GETs never reserve tokens.
    // A zero task budget also prevents an accidental paid completion on this listener.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    for (let i = 0; i < routes.length && !deadline.aborted; i += 8)
      await this.readBatch(catalog, routes.slice(i, i + 8), deadline);
    return catalog;
  }
  private async readBatch(
    catalog: Catalog,
    routes: { provider: string; key: KeydRecord }[],
    deadline: AbortSignal,
  ): Promise<void> {
    const priced = routes.flatMap((route) => {
      const model = Object.values(catalog.providers[route.provider]?.models ?? {}).find(
        (m) => m.inputUSDPerMTok > 0 || m.outputUSDPerMTok > 0,
      );
      return model
        ? [
            {
              ...route,
              pricing: {
                route: route.key.id,
                models: [{ ...keydRouteModel(model), maxOutputTokens: 1 }],
              },
            },
          ]
        : [];
    });
    const unique = [...new Map(priced.map((route) => [route.key.id, route.pricing])).values()];
    if (!unique.length) return;
    const port = this.deps.ports.reserve();
    let agent: ProxyAgent | undefined;
    let opened = false;
    try {
      await this.deps.keyd.closeCell(CELL);
      const cell = await this.deps.keyd.openCell({
        cellId: CELL,
        role: "brain",
        port,
        secrets: unique.map((r) => r.route),
      });
      opened = true;
      if (cell.port !== port) throw new Error("Catalog listener mismatch");
      const taskId = ulid();
      await this.deps.keyd.beginPricedTask(CELL, taskId, { v: 1, routes: unique }, 0);
      const owner = await this.deps.keyd.modelAdmission(CELL);
      if (owner.taskId !== taskId || !owner.paused || owner.active !== 0 || owner.retired)
        throw new Error("Catalog owner changed");
      const active = await this.deps.keyd.setModelAdmission(CELL, {
        taskId,
        generationId: owner.generationId,
        expectedEpoch: owner.epoch,
        state: "open",
      });
      if (
        active.taskId !== taskId ||
        active.generationId !== owner.generationId ||
        active.paused ||
        active.retired
      )
        throw new Error("Catalog admission was not confirmed");
      agent = new ProxyAgent({
        uri: `http://127.0.0.1:${port}`,
        token: `Basic ${Buffer.from(`catalog:${cell.proxyToken}`).toString("base64")}`,
      });
      const fetch = this.deps.fetch ?? undiciFetch;
      let next = 0;
      await Promise.all(
        [0, 1].map(async () => {
          while (next < routes.length && !deadline.aborted) {
            const route = routes[next++];
            if (!route) return;
            const surrogate = cell.surrogates?.[route.key.id];
            if (!surrogate || !SURROGATE_PATTERN.test(surrogate)) continue;
            const headers: Record<string, string> = { accept: "application/json" };
            if (route.key.provider === "anthropic") {
              headers["x-api-key"] = surrogate;
              headers["anthropic-version"] = "2023-06-01";
            } else if (route.key.provider === "google") headers["x-goog-api-key"] = surrogate;
            else if (route.key.provider === "azure") headers["api-key"] = surrogate;
            else headers.authorization = `Bearer ${surrogate}`;
            try {
              let after = "";
              for (let page = 0; page < 10; page++) {
                const query =
                  route.provider === "anthropic"
                    ? `?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`
                    : "";
                const reply = await fetch(`${gatewayBaseURL(route.key.id)}/models${query}`, {
                  method: "GET",
                  headers,
                  dispatcher: agent,
                  redirect: "error",
                  signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]),
                });
                if (!reply.ok) {
                  await reply.body?.cancel();
                  break;
                }
                const raw = JSON.parse(await cappedText(reply, MAX_BYTES));
                applyProviderMetadata(
                  catalog,
                  route.provider,
                  raw,
                  (this.deps.now?.() ?? new Date()).toISOString(),
                );
                if (route.provider !== "anthropic" || raw.has_more !== true) break;
                if (
                  typeof raw.last_id !== "string" ||
                  !/^[A-Za-z0-9._-]{1,128}$/.test(raw.last_id) ||
                  raw.last_id === after
                )
                  break;
                after = raw.last_id;
              }
            } catch {
              /* Partial failure keeps last verified controls; no raw upstream errors logged. */
            }
          }
        }),
      );
    } catch {
      /* keyd unavailable: retain the cache and retry with the next scheduled refresh. */
    } finally {
      if (opened) {
        await this.deps.keyd.endTask(CELL).catch(() => {});
        await this.deps.keyd.closeCell(CELL).catch(() => false);
      }
      await agent?.close().catch(() => {});
      this.deps.ports.release(port);
    }
  }
}
