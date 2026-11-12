import {
  type ActionClass,
  type AlwaysOption,
  type AutonomyPolicy,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";
import { wordList } from "./format.ts";

// As the daemon's hand-off copy names each class (ACTION_CLASS_LABELS), in the language on show.
export const CLASS_LABELS: Readonly<Record<ActionClass, string>> = {
  reading: tr("Read and look"),
  browsing: tr("Browse websites"),
  computer: tr("Work in its computer"),
  download_execute: tr("Run downloaded programs"),
  memory: tr("Save to its memory"),
  send: tr("Send as you"),
  post: tr("Post or publish as you"),
  delete: tr("Delete your online data"),
  system_settings: tr("Change account settings"),
  purchase: tr("Buy or pay"),
  upload: tr("Upload your files"),
  credentials: tr("Passwords, codes and card details"),
  unknown: tr("Unclear steps on signed-in sites"),
  network: tr("Connections beyond websites"),
};

const CLASS_WORK: Readonly<Record<ActionClass, string>> = {
  reading: tr("reading and looking"),
  browsing: tr("browsing websites"),
  computer: tr("working in its computer"),
  download_execute: tr("running downloaded programs"),
  memory: tr("saving to its memory"),
  send: tr("sending messages"),
  post: tr("posting or publishing"),
  delete: tr("deleting your online data"),
  system_settings: tr("changing account settings"),
  purchase: tr("buying or paying"),
  upload: tr("uploading your files"),
  credentials: tr("entering passwords, codes and card details"),
  unknown: tr("unclear steps"),
  network: tr("connections beyond websites"),
};

const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

// A connection's choice names the destination it opened, and the program when it names one.
function connectionChoice(option: AlwaysOption): string {
  return option.app
    ? t`${option.app}'s connections to ${option.destination ?? ""}`
    : t`connections to ${option.destination ?? ""}`;
}

export function allowedLine(actionClass: ActionClass, option: AlwaysOption): string {
  if (actionClass === "network")
    return option.scope === "task"
      ? t`Allowed for this task: ${connectionChoice(option)}.`
      : t`Always allowed: ${connectionChoice(option)}.`;
  const work = CLASS_WORK[actionClass];
  if (option.scope === "always") return t`Always allowed: ${work}.`;
  if (option.scope === "task") return t`Allowed for this task: ${work}.`;
  return t`Allowed ${lower(option.label)}: ${work}.`;
}

export function undoAllowedLabel(actionClass: ActionClass, option: AlwaysOption): string {
  if (actionClass === "network")
    return option.scope === "task"
      ? t`Undo allowing ${connectionChoice(option)} for this task`
      : t`Undo always allowing ${connectionChoice(option)}`;
  const work = CLASS_WORK[actionClass];
  if (option.scope === "always") return t`Undo always allowing ${work}`;
  if (option.scope === "task") return t`Undo allowing ${work} for this task`;
  return t`Undo allowing ${work} ${lower(option.label)}`;
}

export interface AutonomyPreset {
  readonly name: string;
  // The name where room is short, such as a segment.
  readonly label: string;
  readonly recommended?: boolean;
  readonly summary: string;
  readonly policy: Readonly<AutonomyPolicy>;
}

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = [
  {
    name: tr("Balanced (recommended)"),
    label: tr("Balanced"),
    recommended: true,
    summary: tr("Works on its own in its computer and asks before acting as you."),
    policy: BALANCED_AUTONOMY,
  },
  {
    name: tr("Careful"),
    label: tr("Careful"),
    summary: tr("Asks before every step except reading and browsing."),
    policy: CAREFUL_AUTONOMY,
  },
];

export const CUSTOM_SUMMARY = t`Your own mix of choices.`;

export function presetOf(policy: AutonomyPolicy): AutonomyPreset | undefined {
  return AUTONOMY_PRESETS.find((preset) =>
    EDITABLE_ACTION_CLASSES.every((key) => preset.policy[key] === policy[key]),
  );
}

const CHECKED_FIRST = [
  ["purchase", tr("buying")],
  ["send", tr("sending")],
  ["post", tr("posting")],
  ["delete", tr("deleting")],
] as const;

// What dot stops to ask about, in one line for someone who has not opened Settings yet.
export function checksSummary(policy: AutonomyPolicy): string {
  const asks = CHECKED_FIRST.filter(([key]) => policy[key] !== "act").map(([, verb]) => verb);
  const listed = wordList(asks, "disjunction");
  if (policy.computer !== "act") {
    return listed
      ? t`Asks before every step in its computer, and before ${listed}.`
      : t`Asks before every step in its computer.`;
  }
  if (listed) return t`Asks before ${listed}.`;
  return EDITABLE_ACTION_CLASSES.every((key) => policy[key] === "act")
    ? t`Works without asking, even when buying, sending, posting or deleting.`
    : t`Asks before some steps.`;
}
