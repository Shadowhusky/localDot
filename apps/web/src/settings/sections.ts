import type { AutonomyPolicy } from "@localdot/protocol";
import { presetOf } from "../copy/autonomy.ts";
import { dollars } from "../copy/format.ts";
import type { IconName } from "../ui/icons.ts";
import type { SpendingDraft } from "./settings-form.ts";

export type SettingsSection =
  | "models"
  | "autonomy"
  | "rules"
  | "spending"
  | "appearance"
  | "knowledge"
  | "accounts"
  | "keys"
  | "computer";

export interface SectionInfo {
  id: SettingsSection;
  title: string;
  icon: IconName;
}

// In sidebar order, which is also the order of the one scroll they share.
export const SECTIONS: readonly SectionInfo[] = [
  { id: "models", title: "Models", icon: "cpu" },
  { id: "autonomy", title: "Autonomy", icon: "sliders-horizontal" },
  { id: "rules", title: "Always allow", icon: "check-circle" },
  { id: "spending", title: "Spending", icon: "chart" },
  { id: "appearance", title: "Appearance", icon: "contrast" },
  { id: "knowledge", title: "What dot knows", icon: "book" },
  { id: "accounts", title: "Accounts", icon: "globe" },
  { id: "keys", title: "Keys", icon: "key-round" },
  { id: "computer", title: "Your computer", icon: "power" },
];

export const sectionTitle = (id: SettingsSection) =>
  SECTIONS.find((section) => section.id === id)?.title ?? "";

// Under this many pixels from the scroller's top, a section counts as the one being read.
export const SPY_LINE = 24;

// The section the sidebar lights while the content scrolls: the last whose top has reached the
// reading line, or the last of all once the scroll can go no further.
export function sectionInView(
  tops: readonly { id: SettingsSection; top: number }[],
  scroll: { top: number; height: number; content: number },
): SettingsSection | undefined {
  if (tops.length === 0) return undefined;
  if (scroll.top > 0 && scroll.top + scroll.height >= scroll.content - 1) return tops.at(-1)?.id;
  let seen = tops[0]?.id;
  for (const section of tops) if (section.top <= scroll.top + SPY_LINE) seen = section.id;
  return seen;
}

// What a phone's list of sections says at each row's end.
export function autonomyValue(policy: AutonomyPolicy | undefined): string {
  if (!policy) return "";
  return presetOf(policy)?.label ?? "Your own mix";
}

export function spendingValue(spending: SpendingDraft | undefined, plan: boolean): string {
  if (plan) return "Your plan";
  if (!spending?.on) return "No limit";
  const amount = (text: string, per: string) => {
    const value = Number(text);
    return text && Number.isFinite(value) ? `${dollars(value)} a ${per}` : null;
  };
  const limits = [amount(spending.task, "task"), amount(spending.day, "day")].filter(Boolean);
  return limits.length ? limits.join(" · ") : "No limit";
}

export function countValue(count: number | undefined): string {
  return count ? String(count) : "";
}
