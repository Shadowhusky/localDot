import {
  COPY_CATEGORIES,
  type CopyCategory,
  DEFAULT_COPY,
  type DotState,
} from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";

export interface CopyChoice {
  id: CopyCategory;
  label: string;
  note?: string;
}

const CHOICES: Record<CopyCategory, Omit<CopyChoice, "id">> = {
  settings: { label: tr("Settings"), note: tr("Models, autonomy, budgets, persona and accessory") },
  keys: {
    label: tr("Keys"),
    note: tr("Saved keys and passwords, passed from key service to key service"),
  },
  memory: { label: tr("Memory"), note: tr("What dot knows about you") },
  skills: { label: tr("Skills") },
  connectors: { label: tr("Connectors") },
  conversations: { label: tr("Conversations"), note: tr("Can be very large") },
  computer: {
    label: tr("dot's computer"),
    note: tr("Its system files and home folder. Its computer must be stopped."),
  },
  signins: { label: tr("Browser sign-ins"), note: tr("Copied sign-ins can sign each other out") },
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
  if (passphrase.length < MIN_PASSPHRASE) return t`Use at least ${MIN_PASSPHRASE} characters.`;
  if (new TextEncoder().encode(passphrase).length > 1024) return t`That passphrase is too long.`;
  if (passphrase !== again) return t`The passphrases don't match.`;
  return null;
}

export function dotNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t`Give the new dot a name.`;
  if (trimmed.length > 40) return t`Use up to 40 characters.`;
  if (/[\p{Cc}<>]/u.test(trimmed)) return t`Use letters, numbers and punctuation.`;
  return null;
}

export const DOT_STATE_WORD: Record<DotState, string> = {
  running: tr("Running"),
  stopped: tr("Stopped"),
  unknown: tr("Not answering"),
};
