import { arch, availableParallelism, platform, totalmem } from "node:os";
import type { SpeechTierId } from "../../../../packages/protocol/src/speech-install.ts";
import type { SpeechTierSpec } from "./speech-catalog.ts";

export interface SpeechHost {
  platform: string;
  arch: string;
  memoryBytes: number;
  cpus: number;
}

export const hostOfThisComputer = (): SpeechHost => ({
  platform: platform(),
  arch: arch(),
  memoryBytes: totalmem(),
  cpus: availableParallelism(),
});

const GB = 1024 ** 3;

// Half the logical cores, because the other half are usually hyperthreads or slow cores and only
// add contention, and never more than four: beyond that these models hardly get faster.
export const speechThreads = (host: Pick<SpeechHost, "cpus">) =>
  Math.max(1, Math.min(4, Math.ceil(host.cpus / 2)));

// Roughly how many times slower than the four Apple M3 Ultra cores the catalog was measured on. An
// estimate from the kind of chip and how many cores it has: no other machine has been measured.
export function hostSlowness(host: SpeechHost): number {
  const appleSilicon = host.arch === "arm64" && host.platform === "darwin";
  const perCore = appleSilicon ? 1.3 : host.cpus >= 8 ? 1.8 : 2.5;
  return (perCore * 4) / speechThreads(host);
}

// A short message is about this many seconds of speech.
const SHORT_MESSAGE_S = 8;
// Past this for a short message, a lighter tier is the better suggestion.
const COMFORTABLE_S = 7;
const SLOW_S = 15;

export function tierSeconds(host: SpeechHost, tier: SpeechTierSpec): number {
  return (tier.startSeconds + tier.relativeCost * SHORT_MESSAGE_S) * hostSlowness(host);
}

export function tierSpeed(host: SpeechHost, tier: SpeechTierSpec): string {
  const seconds = tierSeconds(host, tier);
  if (seconds < 1.5) return "About a second for a short message";
  if (seconds < 4) return "A couple of seconds for a short message";
  if (seconds < SLOW_S) return "Several seconds for a short message";
  return "Tens of seconds for a short message";
}

export interface TierFit {
  recommended: SpeechTierId;
  warnings: Partial<Record<SpeechTierId, string>>;
}

// The default tier unless this computer would struggle with it, and an honest word about the rest.
// The heaviest is never the suggestion: it's measurably worse for Chinese, and much slower. The person can
// still choose any of them.
export function tierFit(host: SpeechHost, tiers: readonly SpeechTierSpec[]): TierFit {
  const warnings: TierFit["warnings"] = {};
  const comfortable = (tier: SpeechTierSpec) =>
    host.memoryBytes >= tier.minimumMemoryBytes && tierSeconds(host, tier) < COMFORTABLE_S;
  for (const tier of tiers) {
    if (host.memoryBytes < tier.minimumMemoryBytes)
      warnings[tier.id] =
        `Tight on this computer's ${Math.round(host.memoryBytes / GB)} GB of memory. Other apps may slow down while it listens.`;
    else if (tierSeconds(host, tier) >= SLOW_S)
      warnings[tier.id] = "Will be slow on this computer: long messages can take a minute.";
    else if (tierSeconds(host, tier) >= COMFORTABLE_S)
      warnings[tier.id] = "Will be noticeably slower on this computer.";
  }
  const [light, balanced] = tiers;
  const recommended = balanced && comfortable(balanced) ? balanced : (light ?? balanced);
  return { recommended: recommended?.id ?? "balanced", warnings };
}
