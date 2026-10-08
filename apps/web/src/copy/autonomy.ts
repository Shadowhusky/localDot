import {
  type ActionClass,
  type AlwaysOption,
  type AutonomyPolicy,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";

export const CLASS_LABELS: Readonly<Record<ActionClass, string>> = {
  reading: "Read and look",
  browsing: "Browse websites",
  computer: "Work in its computer",
  download_execute: "Run programs from the internet",
  memory: "Save to its memory",
  send: "Send as you",
  post: "Post or publish as you",
  delete: "Delete your online data",
  system_settings: "Change account settings",
  purchase: "Buy or pay",
  upload: "Upload your files",
  credentials: "Passwords, codes and card details",
  unknown: "Unclear steps on signed-in sites",
};

const CLASS_WORK: Readonly<Record<ActionClass, string>> = {
  reading: "reading and looking",
  browsing: "browsing websites",
  computer: "working in its computer",
  download_execute: "running programs from the internet",
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

export function allowedLine(actionClass: ActionClass, option: AlwaysOption): string {
  const where =
    option.scope === "always"
      ? "Always allowed"
      : `Allowed ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)}`;
  return `${where}: ${CLASS_WORK[actionClass]}.`;
}

export interface AutonomyPreset {
  readonly name: string;
  readonly summary: string;
  readonly policy: Readonly<AutonomyPolicy>;
}

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = [
  {
    name: "Balanced (recommended)",
    summary: "Works on its own in its computer and asks before acting as you.",
    policy: BALANCED_AUTONOMY,
  },
  {
    name: "Careful",
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
