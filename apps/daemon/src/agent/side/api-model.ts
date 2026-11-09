import type { ModelBinding, ReasoningEffort } from "@localdot/protocol";
import type { fetch as undiciFetch } from "undici";
import type { ResolvedRole } from "../bindings.ts";
import type { SideGo, SideModel } from "./agent.ts";
import { type SideMessage, sideStep } from "./wire.ts";

export interface SideListener {
  readonly binding: ModelBinding;
  readonly at: { readonly port: number; readonly token: string };
  readonly effort?: ReasoningEffort;
  close(): Promise<void>;
}
// A keyd listener of the question's own, with this model's key and what's left of its limit: its
// cost never reaches the task's budget, and keyd stops it at the limit even if this count is wrong.
export type OpenSideListener = (
  role: ResolvedRole,
  budgetUSD: number | undefined,
  signal: AbortSignal,
) => Promise<SideListener>;

const FINISH_NOW =
  "Now call finish with your result: found, partial or not_found. Only finish ends this.";

const usdOf = (role: ResolvedRole, input: number, output: number) =>
  role.flat
    ? 0
    : (input * role.model.inputUSDPerMTok + output * role.model.outputUSDPerMTok) / 1_000_000;

// A model billed per token, through keyd, asked in its own API with the side agent's tools only.
export function apiSideModel(
  role: ResolvedRole,
  side: SideModel["role"],
  open: OpenSideListener,
  fetch?: typeof undiciFetch,
): SideModel {
  return {
    provider: role.providerId,
    model: role.model.id,
    role: side,
    tools: role.model.toolCall,
    images: role.model.vision,
    run: async (go: SideGo) => {
      const priced = role.model.inputUSDPerMTok > 0 || role.model.outputUSDPerMTok > 0;
      const listener = await open(role, priced && !role.flat ? go.leftUSD : undefined, go.signal);
      try {
        const messages: SideMessage[] = [{ role: "user", text: go.prompt }];
        let nudged = false;
        for (let turn = 0; turn < go.turns; turn++) {
          go.signal.throwIfAborted();
          const step = await sideStep(
            listener.binding,
            listener.at,
            go.system,
            messages,
            go.tools.offered(),
            go.signal,
            listener.effort,
            fetch,
          );
          go.used({
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            usd: usdOf(role, step.inputTokens, step.outputTokens),
          });
          go.note(step.text);
          messages.push({ role: "assistant", step });
          if (!step.calls.length) {
            // Only finish says whether it found the answer; its words are not read for that.
            if (nudged) return;
            nudged = true;
            messages.push({ role: "user", text: FINISH_NOW });
            continue;
          }
          const results = [];
          for (const call of step.calls)
            results.push({ call, result: await go.tools.call(call.name, call.input, go.signal) });
          if (go.tools.finished) return;
          messages.push({ role: "tools", results });
        }
      } finally {
        await listener.close();
      }
    },
  };
}
