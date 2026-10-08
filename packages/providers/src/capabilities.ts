import type { ComputerMode, CoordSpaceName } from "@localdot/protocol";
import type { CatalogModel } from "./catalog.ts";
import type { ProviderSpec } from "./registry.ts";

export type CapabilityTier = "native" | "vision-tools" | "text-only" | "no-tools";

export interface Capability {
  tier: CapabilityTier;
  computer: ComputerMode;
  coords: CoordSpaceName;
  // What the picker says about the model (spec "Catalog": "and the picker says so").
  note: string;
}

// @ai-sdk/anthropic 4.0.69 documents computer_toolset_20260801 for Opus 5.5, Opus 5, Sonnet 5,
// Fable 5 and 5.1 and Opus 4.8; Sonnet 5.5 is assumed to take it too (S5: unverified, no credit).
const ANTHROPIC_TOOLSET = /^claude-(opus|sonnet|fable)-5(?:[-.]\d+)?(?:-\d{8})?$|^claude-opus-4-8/;
const ANTHROPIC_LEGACY = /^claude-(haiku-4-5|sonnet-4|opus-4-[0-7]|3-7-sonnet)/;
// S5 and D9: Gemini and Qwen answer on the 0–1000 grid even when told pixels, whoever serves them
// (OpenRouter names them google/gemini-… and qwen/…). GLM vision models do too (the GLM-V paper).
const PER1000 = (provider: ProviderSpec, model: CatalogModel) =>
  provider.client === "google" || /gemini|qwen|glm/i.test(model.id);

export function capabilityOf(provider: ProviderSpec, model: CatalogModel): Capability {
  if (!model.toolCall) {
    return {
      tier: "no-tools",
      computer: "none",
      coords: "pixels",
      note: "Cannot call tools: chat, titles and summaries only",
    };
  }
  if (provider.client === "anthropic" && model.vision) {
    if (ANTHROPIC_TOOLSET.test(model.id)) {
      return {
        tier: "native",
        computer: "anthropic-toolset",
        coords: "pixels",
        note: "Native computer use",
      };
    }
    if (ANTHROPIC_LEGACY.test(model.id)) {
      return {
        tier: "native",
        computer: "anthropic-legacy",
        coords: "pixels",
        note: "Native computer use (older tool)",
      };
    }
  }
  if (model.vision) {
    const coords = PER1000(provider, model) ? "per1000" : "pixels";
    return {
      tier: "vision-tools",
      computer: "generic",
      coords,
      note: "Uses localDot's computer tool",
    };
  }
  return {
    tier: "text-only",
    computer: "none",
    coords: "pixels",
    note: "Can use the shell, files and page reading, but not the screen",
  };
}

// The main role drives the computer, so it must call tools; the spec's "main" wants vision too,
// but a text-only main still works through shell, files and page reading.
export function usableAs(role: "main" | "fast" | "local", c: Capability): boolean {
  if (role === "fast") return true;
  return c.tier !== "no-tools";
}
