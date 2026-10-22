import type { PremiumSpeed } from "@localdot/protocol";
import { providerById } from "./registry.ts";

// A premium speed a model offers, and the price per token it costs over the standard rate. A
// price the vendor doesn't publish is left out: the speed costs more, but by how much is unknown.
export interface SpeedTier {
  readonly speed: PremiumSpeed;
  readonly price?: number;
}
// What a task sets aside for a speed whose premium is unknown: the highest one any vendor charges.
const HIGHEST: Readonly<Record<PremiumSpeed, number>> = { fast: 2.5, ultrafast: 6 };
const fast = (price?: number): SpeedTier => ({ speed: "fast", ...(price ? { price } : {}) });
const ultrafast = (price?: number): SpeedTier => ({
  speed: "ultrafast",
  ...(price ? { price } : {}),
});

// Reviewed against vendor documentation on 2026-10-21 (docs/model-options.md).
function openai(model: string): SpeedTier[] {
  if (
    !/^gpt-[56](?:[.-]|$)/.test(model) ||
    /nano|(?:^|-)pro(?:-|$)|chat|search|audio|realtime|image|transcribe|tts/.test(model)
  )
    return [];
  return [
    fast(/^gpt-5\.5(?:-|$)/.test(model) ? 2.5 : 2),
    ...(/^gpt-(?:6\.1-sol|6-astra)(?:-|$)/.test(model) ? [ultrafast(6)] : []),
  ];
}
function anthropic(model: string): SpeedTier[] {
  return /^claude-opus-(?:5(?:-5)?|4-8)(?:$|-20)/.test(model.replaceAll(".", "-")) ? [fast(2)] : [];
}
// The Gemini API's priority tier; Vertex has its own, which isn't offered here.
function google(model: string): SpeedTier[] {
  return /^gemini-(?:3\.8-flash|3\.6-flash|3\.5-flash-lite|3\.1-(?:pro|flash-lite)|3-flash|2\.5-(?:pro|flash))(?:-|$)/.test(
    model,
  ) && !/image|tts|live|audio|embed/.test(model)
    ? [fast(1.8)]
    : [];
}
function xai(model: string): SpeedTier[] {
  return /^grok-/.test(model) && !/imagine|image|video/.test(model) ? [fast(2)] : [];
}

// The speeds a model offers through a provider's API. `tiered` says a custom endpoint takes OpenAI's
// service tiers: its OpenAI models get OpenAI's tiers, any other model both speeds at an unknown
// premium, and Ultrafast only through the Responses format, the only one OpenAI offers it on.
export function speedTiers(
  provider: string,
  modelId: string,
  tiered = false,
): readonly SpeedTier[] {
  const model = modelId.toLowerCase();
  const spec = providerById(provider);
  if (spec?.custom) {
    if (!tiered || spec.client === "anthropic-compatible") return [];
    const tiers = /^(?:gpt-|o)\d/.test(model) ? openai(model) : [fast(), ultrafast()];
    return spec.client === "openai" ? tiers : tiers.filter((tier) => tier.speed === "fast");
  }
  if (provider === "openai") return openai(model);
  if (provider === "anthropic") return anthropic(model);
  // Claude Code's fast mode, on the same Opus models, draws on the plan's usage credits; the
  // account's model list says where it is on. A ChatGPT plan's tiers come only from its account.
  if (provider === "claude-code")
    return model === "opus" ? [fast()] : anthropic(model).map(() => fast());
  if (provider === "google") return google(model);
  if (provider === "xai") return xai(model);
  // A routing variant such as :nitro or :free picks its own endpoints.
  if (provider === "openrouter" && !model.includes(":")) {
    const [vendor, bare = ""] = model.split("/");
    if (vendor === "openai") return openai(bare);
    if (vendor === "anthropic") return anthropic(bare);
    if (vendor === "google") return google(bare);
    if (vendor === "x-ai") return xai(bare);
  }
  return [];
}

// What a task sets aside per token at a premium speed, over the standard rate. Providers may serve
// a premium request at the standard tier and bill that, never more, so this is an upper bound.
export function speedPremium(
  provider: string,
  model: string,
  speed: PremiumSpeed,
  tiered = false,
): number {
  return (
    speedTiers(provider, model, tiered).find((tier) => tier.speed === speed)?.price ??
    HIGHEST[speed]
  );
}

// The premium speed a provider's report names: OpenAI-style service tiers, where priority and fast
// are one tier, Gemini's SERVICE_TIER_ names, Groq's performance tier and Anthropic's usage speed.
// Standard tiers name none.
export function servedSpeed(report: unknown): PremiumSpeed | undefined {
  if (typeof report !== "string") return undefined;
  const tier = report.toLowerCase().replace(/^service_tier_/, "");
  if (tier === "ultrafast") return "ultrafast";
  if (["priority", "fast", "performance"].includes(tier)) return "fast";
  return undefined;
}
