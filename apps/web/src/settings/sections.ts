import type { AutonomyPolicy } from "@localdot/protocol";
import { presetOf } from "../copy/autonomy.ts";
import { dollars } from "../copy/format.ts";
import { t, tr } from "../i18n/index.ts";
import type { DeviceState } from "../notify/this-device.ts";
import type { IconName } from "../ui/icons.ts";
import type { SpendingDraft } from "./settings-form.ts";

export type SettingsSection =
  | "dot"
  | "models"
  | "autonomy"
  | "rules"
  | "spending"
  | "appearance"
  | "voice"
  | "notifications"
  | "knowledge"
  | "accounts"
  | "connectors"
  | "keys"
  | "computer"
  | "report";

export interface SectionInfo {
  id: SettingsSection;
  title: string;
  icon: IconName;
}

// Sidebar and phone index order; each section has its own page.
export const SECTIONS: readonly SectionInfo[] = [
  { id: "dot", title: tr("Your dot"), icon: "smile" },
  { id: "models", title: tr("Models"), icon: "cpu" },
  { id: "autonomy", title: tr("Autonomy"), icon: "sliders-horizontal" },
  { id: "rules", title: tr("Always allow"), icon: "check-circle" },
  { id: "spending", title: tr("Spending"), icon: "chart" },
  { id: "appearance", title: tr("Appearance"), icon: "contrast" },
  { id: "voice", title: tr("Voice"), icon: "mic" },
  { id: "notifications", title: tr("Notifications"), icon: "bell" },
  { id: "knowledge", title: tr("What dot knows"), icon: "book" },
  { id: "accounts", title: tr("Accounts"), icon: "globe" },
  { id: "connectors", title: tr("Connectors"), icon: "plug" },
  { id: "keys", title: tr("Keys"), icon: "key-round" },
  { id: "computer", title: tr("Your computer"), icon: "power" },
  { id: "report", title: tr("Report a problem"), icon: "circle-alert" },
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
  return presetOf(policy)?.label ?? t`Your own mix`;
}

export function spendingValue(spending: SpendingDraft | undefined, plan: boolean): string {
  if (plan) return t`Your plan`;
  if (!spending?.on) return t`No limit`;
  const amount = (text: string) => {
    const value = Number(text);
    return text && Number.isFinite(value) ? dollars(value) : null;
  };
  const task = amount(spending.task);
  const day = amount(spending.day);
  const limits = [task && t`${task} a task`, day && t`${day} a day`].filter(Boolean);
  return limits.length ? limits.join(" · ") : t`No limit`;
}

export function countValue(count: number | undefined): string {
  return count ? String(count) : "";
}

export function notificationsValue(device: DeviceState | null | undefined): string {
  if (device?.kind === "on") return t`On`;
  if (device?.kind === "off") return t`Off`;
  if (device?.kind === "needs-home-screen") return t`Set up`;
  return "";
}
