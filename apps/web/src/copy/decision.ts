import {
  ACTION_CLASS_LABELS,
  type ActionClass,
  type AlwaysScope,
  type ApprovalCard,
} from "@localdot/protocol";

export interface DecisionWords {
  // A question with the action's own verb.
  title: string;
  primary: string;
  secondary: string;
  // One sentence on why this asks.
  why: string;
}

const QUESTION: Readonly<Record<ActionClass, string>> = {
  reading: "Read this?",
  browsing: "Open this website?",
  computer: "Do this on your computer?",
  purchase: "Make this payment?",
  send: "Send this as you?",
  post: "Post this as you?",
  delete: "Delete this online data?",
  download_execute: "Run this downloaded program?",
  system_settings: "Change this account setting?",
  memory: "Save this to dot's memory?",
  upload: "Upload these files?",
  credentials: "Use this password or code?",
  unknown: "Allow this step?",
};

const VERB: Partial<Readonly<Record<ActionClass, string>>> = {
  purchase: "Buy",
  send: "Send",
  post: "Post",
  delete: "Delete",
  download_execute: "Run",
  system_settings: "Change",
  memory: "Save",
  upload: "Upload",
};

// Acting as you always asks; everything else asks because your settings say so.
const ALWAYS_ASKS: Partial<Readonly<Record<ActionClass, string>>> = {
  purchase: "Paying",
  send: "Sending as you",
  post: "Posting as you",
  delete: "Deleting your online data",
  system_settings: "Changing your account",
  upload: "Sharing your files",
  credentials: "Using a password or code",
};

const WORK: Readonly<Record<ActionClass, string>> = {
  reading: "reading",
  browsing: "opening websites",
  computer: "steps on your computer",
  purchase: "paying",
  send: "sending",
  post: "posting",
  delete: "deleting",
  download_execute: "running downloaded programs",
  system_settings: "changing accounts",
  memory: "saving to memory",
  upload: "uploading files",
  credentials: "using passwords",
  unknown: "unclear steps",
};

const WAITS = "dot waits here; nothing times out.";

// The daemon's own words for this action win; its plain class name becomes a question.
export function decisionWords(card: Pick<ApprovalCard, "actionClass" | "title">): DecisionWords {
  const { actionClass } = card;
  const verb = VERB[actionClass] ?? "Allow";
  const always = ALWAYS_ASKS[actionClass];
  return {
    title: card.title === ACTION_CLASS_LABELS[actionClass] ? QUESTION[actionClass] : card.title,
    primary: verb,
    secondary: `Don't ${verb.toLowerCase()}`,
    why: always
      ? `${always} always needs your OK. ${WAITS}`
      : `Your settings ask before ${WORK[actionClass]}. ${WAITS}`,
  };
}

export const ONCE = "once";
export type DecisionScope = AlwaysScope | typeof ONCE;

// How far a yes reaches until changed: once for anything that acts as you, this task for the rest.
export function defaultScope(card: Pick<ApprovalCard, "actionClass" | "always">): DecisionScope {
  if (ALWAYS_ASKS[card.actionClass]) return ONCE;
  return card.always?.some((option) => option.scope === "task") ? "task" : ONCE;
}
