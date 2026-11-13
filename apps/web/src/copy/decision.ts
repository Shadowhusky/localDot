import {
  ACTION_CLASS_LABELS,
  type ActionClass,
  type AlwaysScope,
  type ApprovalCard,
} from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";

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
  reading: tr("Read this?"),
  browsing: tr("Open this website?"),
  computer: tr("Do this on your computer?"),
  purchase: tr("Make this payment?"),
  send: tr("Send this as you?"),
  post: tr("Post this as you?"),
  delete: tr("Delete this online data?"),
  download_execute: tr("Run this downloaded program?"),
  system_settings: tr("Change this account setting?"),
  memory: tr("Save this to dot's memory?"),
  upload: tr("Upload these files?"),
  credentials: tr("Use this password or code?"),
  unknown: tr("Allow this step?"),
  network: tr("Allow this connection?"),
};

const ASK: Readonly<Record<ActionClass, string>> = {
  reading: tr("Can I read this?"),
  browsing: tr("Can I open this website?"),
  computer: tr("Can I do this on your computer?"),
  purchase: tr("Can I make this payment?"),
  send: tr("Can I send this as you?"),
  post: tr("Can I post this as you?"),
  delete: tr("Can I delete this online data?"),
  download_execute: tr("Can I run this downloaded program?"),
  system_settings: tr("Can I change this account setting?"),
  memory: tr("Can I save this to my memory?"),
  upload: tr("Can I upload these files?"),
  credentials: tr("Can I use this password or code?"),
  unknown: tr("Can I take this step?"),
  network: tr("Can I let this app connect?"),
};

// A question for the user, such as "Send this email?", becomes dot asking to do it.
function askLine(actionClass: ActionClass, title: string): string {
  if (!title || title === QUESTION[actionClass]) return ASK[actionClass];
  if (!title.endsWith("?")) return title;
  return `Can I ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

// The answers, yes and no, with the action's own verb.
const VERB: Partial<Readonly<Record<ActionClass, readonly [string, string]>>> = {
  purchase: [tr("Buy"), tr("Don't buy")],
  send: [tr("Send"), tr("Don't send")],
  post: [tr("Post"), tr("Don't post")],
  delete: [tr("Delete"), tr("Don't delete")],
  download_execute: [tr("Run"), tr("Don't run")],
  system_settings: [tr("Change"), tr("Don't change")],
  memory: [tr("Save"), tr("Don't save")],
  upload: [tr("Upload"), tr("Don't upload")],
};

// Acting as you always asks; everything else asks because your settings say so.
const ALWAYS_ASKS: Partial<Readonly<Record<ActionClass, string>>> = {
  purchase: tr("Paying"),
  send: tr("Sending as you"),
  post: tr("Posting as you"),
  delete: tr("Deleting your online data"),
  system_settings: tr("Changing your account"),
  upload: tr("Sharing your files"),
  credentials: tr("Using a password or code"),
};

const WORK: Readonly<Record<ActionClass, string>> = {
  reading: tr("reading"),
  browsing: tr("opening websites"),
  computer: tr("steps on your computer"),
  purchase: tr("paying"),
  send: tr("sending"),
  post: tr("posting"),
  delete: tr("deleting"),
  download_execute: tr("running downloaded programs"),
  system_settings: tr("changing accounts"),
  memory: tr("saving to memory"),
  upload: tr("uploading files"),
  credentials: tr("using passwords"),
  unknown: tr("unclear steps"),
  network: tr("connections beyond websites"),
};

// The daemon's own words for this action and its reason win; its plain class name becomes a
// question.
// `connection`: the card is an app's connection, which the task does not wait on, not one of the
// task's own decisions.
export function decisionWords(
  card: Pick<ApprovalCard, "actionClass" | "title" | "why"> & Partial<Pick<ApprovalCard, "fields">>,
  { connection }: { connection: boolean },
): DecisionWords {
  const { actionClass } = card;
  const [primary, secondary] = VERB[actionClass] ?? [t`Allow`, t`Don't allow`];
  const always = ALWAYS_ASKS[actionClass];
  const title =
    card.title === ACTION_CLASS_LABELS[actionClass] ? QUESTION[actionClass] : card.title;
  // A connection is the app's, not dot's: dot keeps working, so its reason stands alone.
  const network = connection;
  return {
    title,
    primary,
    secondary,
    why: network
      ? (card.why ?? t`Apps reach websites on their own; anything else waits for your OK.`)
      : card.why
        ? t`${card.why} dot waits here; nothing times out.`
        : always
          ? t`${always} always needs your OK. dot waits here; nothing times out.`
          : t`Your settings ask before ${WORK[actionClass]}. dot waits here; nothing times out.`,
    line: (network && connectionLine(card.fields)) || askLine(actionClass, title),
  };
}

// dot says which app is reaching out, while the card waits.
function connectionLine(fields: ApprovalCard["fields"] | undefined): string | undefined {
  const app = fields?.find(([label]) => label === "App")?.[1];
  if (!fields) return undefined;
  return app && app !== NOT_KNOWN
    ? t`${app} is trying to reach a new server.`
    : t`An app is trying to reach a new server.`;
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
