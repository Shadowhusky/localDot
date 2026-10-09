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
  // dot's own line while it waits, asking in the first person.
  line: string;
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
  network: "Allow this connection?",
};

const ASK: Readonly<Record<ActionClass, string>> = {
  reading: "Can I read this?",
  browsing: "Can I open this website?",
  computer: "Can I do this on your computer?",
  purchase: "Can I make this payment?",
  send: "Can I send this as you?",
  post: "Can I post this as you?",
  delete: "Can I delete this online data?",
  download_execute: "Can I run this downloaded program?",
  system_settings: "Can I change this account setting?",
  memory: "Can I save this to my memory?",
  upload: "Can I upload these files?",
  credentials: "Can I use this password or code?",
  unknown: "Can I take this step?",
  network: "Can I let this app connect?",
};

// A question for the user, such as "Send this email?", becomes dot asking to do it.
function askLine(actionClass: ActionClass, title: string): string {
  if (!title || title === QUESTION[actionClass]) return ASK[actionClass];
  if (!title.endsWith("?")) return title;
  return `Can I ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

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
  network: "connections beyond websites",
};

const WAITS = "dot waits here; nothing times out.";
// A connection is the app's, not dot's: dot keeps working, and the app tries again once allowed.
const RETRIES = "The app tries again once you allow it; nothing times out.";

// The daemon's own words for this action and its reason win; its plain class name becomes a
// question.
export function decisionWords(
  card: Pick<ApprovalCard, "actionClass" | "title" | "why"> & Partial<Pick<ApprovalCard, "fields">>,
): DecisionWords {
  const { actionClass } = card;
  const verb = VERB[actionClass] ?? "Allow";
  const always = ALWAYS_ASKS[actionClass];
  const title =
    card.title === ACTION_CLASS_LABELS[actionClass] ? QUESTION[actionClass] : card.title;
  const network = actionClass === "network";
  const waits = network ? RETRIES : WAITS;
  return {
    title,
    primary: verb,
    secondary: `Don't ${verb.toLowerCase()}`,
    why: card.why
      ? `${card.why} ${waits}`
      : always
        ? `${always} always needs your OK. ${waits}`
        : network
          ? `Apps reach websites freely; anything else waits for your OK. ${waits}`
          : `Your settings ask before ${WORK[actionClass]}. ${waits}`,
    line: (network && connectionLine(card.fields)) || askLine(actionClass, title),
  };
}

// dot says which app is reaching out, while the card waits.
function connectionLine(fields: ApprovalCard["fields"] | undefined): string | undefined {
  const app = fields?.find(([label]) => label === "App")?.[1];
  if (!fields) return undefined;
  return `${app && app !== NOT_KNOWN ? app : "An app"} is trying to reach a new server.`;
}

// The daemon's word for an app it couldn't name.
export const NOT_KNOWN = "Not known";

export const ONCE = "once";
export type DecisionScope = AlwaysScope | typeof ONCE;

// How far a yes reaches until changed: once for anything that acts as you or sends what dot read
// somewhere new, this task for the rest.
export function defaultScope(
  card: Pick<ApprovalCard, "actionClass" | "always" | "destinations">,
): DecisionScope {
  if (ALWAYS_ASKS[card.actionClass] || card.destinations) return ONCE;
  return card.always?.some((option) => option.scope === "task") ? "task" : ONCE;
}
