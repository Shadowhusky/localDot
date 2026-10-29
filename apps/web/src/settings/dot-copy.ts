import {
  COPY_CATEGORIES,
  type CopyCategory,
  DEFAULT_COPY,
  type DotState,
} from "@localdot/protocol";

export interface CopyChoice {
  id: CopyCategory;
  label: string;
  note?: string;
}

const CHOICES: Record<CopyCategory, Omit<CopyChoice, "id">> = {
  settings: { label: "Settings", note: "Models, autonomy, budgets, persona and accessory" },
  keys: { label: "Keys", note: "Saved keys and passwords, passed from key service to key service" },
  memory: { label: "Memory", note: "What dot knows about you" },
  skills: { label: "Skills" },
  connectors: { label: "Connectors" },
  conversations: { label: "Conversations", note: "Can be very large" },
  computer: {
    label: "dot's computer",
    note: "Its system files and home folder. Its computer must be stopped.",
  },
  signins: { label: "Browser sign-ins", note: "Copied sign-ins can sign each other out" },
};

export const COPY_CHOICES: readonly CopyChoice[] = COPY_CATEGORIES.map((id) => ({
  id,
  ...CHOICES[id],
}));

export const defaultCopy = (): ReadonlySet<CopyCategory> => new Set(DEFAULT_COPY);

// In the order the list shows them, so a request reads the same however it was ticked.
export const chosenCopy = (chosen: ReadonlySet<CopyCategory>): CopyCategory[] =>
  COPY_CATEGORIES.filter((id) => chosen.has(id));

export function toggled(
  chosen: ReadonlySet<CopyCategory>,
  id: CopyCategory,
  on: boolean,
): ReadonlySet<CopyCategory> {
  const next = new Set(chosen);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export const MIN_PASSPHRASE = 12;

export function passphraseProblem(passphrase: string, again: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (new TextEncoder().encode(passphrase).length > 1024) return "That passphrase is too long.";
  if (passphrase !== again) return "The passphrases don't match.";
  return null;
}

export function dotNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the new dot a name.";
  if (trimmed.length > 40) return "Use up to 40 characters.";
  if (/[\p{Cc}<>]/u.test(trimmed)) return "Use letters, numbers and punctuation.";
  return null;
}

export const DOT_STATE_WORD: Record<DotState, string> = {
  running: "Running",
  stopped: "Stopped",
  unknown: "Not answering",
};
