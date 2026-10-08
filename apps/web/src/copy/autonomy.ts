import {
  ACTION_CLASS_LABELS,
  type ActionClass,
  type AlwaysOption,
  type AutonomyPolicy,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";

// The daemon's hand-off copy names a class the same way.
export const CLASS_LABELS = ACTION_CLASS_LABELS;

const CLASS_WORK: Readonly<Record<ActionClass, string>> = {
  reading: "reading and looking",
  browsing: "browsing websites",
  computer: "working in its computer",
  download_execute: "running downloaded programs",
  memory: "saving to its memory",
  send: "sending messages",
  post: "posting or publishing",
  delete: "deleting your online data",
  system_settings: "changing account settings",
  purchase: "buying or paying",
  upload: "uploading your files",
  credentials: "entering passwords, codes and card details",
  unknown: "unclear steps",
};

export function allowWithoutAsking(actionClass: ActionClass): string {
  return `Allow ${CLASS_WORK[actionClass]} without asking:`;
}

const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

export function allowedLine(actionClass: ActionClass, option: AlwaysOption): string {
  const where = option.scope === "always" ? "Always allowed" : `Allowed ${lower(option.label)}`;
  return `${where}: ${CLASS_WORK[actionClass]}.`;
}

export function undoAllowedLabel(actionClass: ActionClass, option: AlwaysOption): string {
  return option.scope === "always"
    ? `Undo always allowing ${CLASS_WORK[actionClass]}`
    : `Undo allowing ${CLASS_WORK[actionClass]} ${lower(option.label)}`;
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
    name: "Balanced (recommended)",
    label: "Balanced",
    recommended: true,
    summary: "Works on its own in its computer and asks before acting as you.",
    policy: BALANCED_AUTONOMY,
  },
  {
    name: "Careful",
    label: "Careful",
    summary: "Asks before every step except reading and browsing.",
    policy: CAREFUL_AUTONOMY,
  },
];

export const CUSTOM_SUMMARY = "Your own mix of choices.";

export function presetOf(policy: AutonomyPolicy): AutonomyPreset | undefined {
  return AUTONOMY_PRESETS.find((preset) =>
    EDITABLE_ACTION_CLASSES.every((key) => preset.policy[key] === policy[key]),
  );
}

const CHECKED_FIRST = [
  ["purchase", "buying"],
  ["send", "sending"],
  ["post", "posting"],
  ["delete", "deleting"],
] as const;

// What dot stops to ask about, in one line for someone who has not opened Settings yet.
export function checksSummary(policy: AutonomyPolicy): string {
  const asks = CHECKED_FIRST.filter(([key]) => policy[key] !== "act").map(([, verb]) => verb);
  const listed =
    asks.length > 1 ? `${asks.slice(0, -1).join(", ")} or ${asks.at(-1)}` : (asks[0] ?? "");
  if (policy.computer !== "act") {
    return listed
      ? `Asks before every step in its computer, and before ${listed}.`
      : "Asks before every step in its computer.";
  }
  if (listed) return `Asks before ${listed}.`;
  return EDITABLE_ACTION_CLASSES.every((key) => policy[key] === "act")
    ? "Works without asking, even when buying, sending, posting or deleting."
    : "Asks before some steps.";
}
