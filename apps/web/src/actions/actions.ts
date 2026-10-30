import type { IconName } from "../ui/icons.ts";

// One list of what the user can do from the keyboard: the composer's slash commands are the actions
// with a command name, and the palette (Mod+K) searches them all.
export type ActionGroup = "Task" | "Conversation" | "dot" | "Go to" | "Settings" | "Help";

export interface ActionChoice {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly keywords?: string;
  readonly current?: boolean;
  readonly unavailable?: string;
}

export interface ActionInput {
  readonly text: string;
  readonly choice?: ActionChoice;
  // What to give focus back to when what the action opens closes.
  readonly trigger: HTMLElement | null;
}

export interface Action {
  readonly id: string;
  readonly title: string;
  // Typed after "/" in the composer.
  readonly command?: string;
  readonly description: string;
  // What the command takes, as it reads after its name.
  readonly hint?: string;
  readonly group: ActionGroup;
  readonly icon?: IconName;
  readonly keywords?: string;
  readonly keys?: readonly string[];
  readonly unavailable?: string;
  // Words the user writes for it: a question, a name.
  readonly input?: "required" | "optional";
  readonly placeholder?: string;
  readonly choices?:
    | readonly ActionChoice[]
    | ((signal: AbortSignal) => Promise<readonly ActionChoice[]>);
  // Its choices are found by the palette's search, each a row of its own.
  readonly searchable?: boolean;
  // A string it returns, or resolves to, says why it didn't happen, where the user ran it.
  run(input: ActionInput): unknown;
}

// Text in the composer that reads as a command: "/" and a name, then what the command is given.
// Anything else ("/usr/bin", "/ hello", "//") is a message.
export interface CommandText {
  readonly name: string;
  // A space follows the name: what comes after it is the command's.
  readonly spaced: boolean;
  readonly arg: string;
}
const SHAPE = /^\/([a-z][a-z0-9-]*)?(?:(\s)([\s\S]*))?$/i;
export function commandText(value: string): CommandText | null {
  const match = SHAPE.exec(value);
  if (!match || (!match[1] && match[2])) return null;
  return {
    name: (match[1] ?? "").toLowerCase(),
    spaced: match[2] !== undefined,
    arg: match[3] ?? "",
  };
}

// The letters in order within one word, as "rnm" in "rename".
function inOrder(text: string, word: string): boolean {
  let at = 0;
  for (const char of word) {
    at = text.indexOf(char, at) + 1;
    if (!at) return false;
  }
  return true;
}

// How well a search fits a text: each of its words is found at the start of a word (best), anywhere
// in one, or as letters in order within one word (worst). Zero when one word isn't found at all.
export function fit(text: string, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const at = hay.indexOf(word);
    if (at === 0 || (at > 0 && /[\s/:·(-]/.test(hay[at - 1] as string))) total += 3;
    else if (at > 0) total += 2;
    else if (word.length > 2 && hay.split(/[\s/:·(-]+/).some((part) => inOrder(part, word)))
      total += 1;
    else return 0;
  }
  return total;
}

const ranked = <T>(items: readonly T[], score: (item: T) => number): T[] =>
  items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);

// The commands a typed name could mean: those it starts first, then those it is part of; only when
// it names none, those whose words it finds.
export function matchCommands(actions: readonly Action[], name: string): Action[] {
  const commands = actions.filter((action) => action.command);
  if (!name) return commands;
  const named = ranked(commands, (action) => {
    const command = action.command as string;
    return command.startsWith(name) ? 2 : command.includes(name) ? 1 : 0;
  });
  return named.length
    ? named
    : ranked(commands, (action) => fit(`${action.title} ${action.keywords ?? ""}`, name));
}

export function findCommand(actions: readonly Action[], name: string): Action | undefined {
  return actions.find((action) => action.command === name);
}

// A title that fits counts twice what fits only in its other words.
export const actionFit = (action: Action, query: string) =>
  Math.max(
    fit(action.title, query) * 2,
    fit(
      `${action.command ? `/${action.command}` : ""} ${action.title} ${action.keywords ?? ""} ${action.group}`,
      query,
    ),
  );
export const choiceFit = (choice: ActionChoice, query: string) =>
  Math.max(
    fit(choice.label, query) * 2,
    fit(`${choice.label} ${choice.detail ?? ""} ${choice.keywords ?? ""}`, query),
  );

export function matchActions(actions: readonly Action[], query: string): Action[] {
  if (!query.trim()) return [...actions];
  return ranked(actions, (action) => actionFit(action, query));
}

export function matchChoices(choices: readonly ActionChoice[], query: string): ActionChoice[] {
  if (!query.trim()) return [...choices];
  return ranked(choices, (choice) => choiceFit(choice, query));
}

export const choicesOf = (action: Action) =>
  typeof action.choices === "function" ? undefined : action.choices;

// A row of the slash menu or the palette: an action to choose, one of its choices, or the action
// run on the words written for it.
export type ActionRow =
  | { readonly kind: "action"; readonly key: string; readonly action: Action }
  | {
      readonly kind: "choice";
      readonly key: string;
      readonly action: Action;
      readonly choice: ActionChoice;
    }
  | { readonly kind: "text"; readonly key: string; readonly action: Action; readonly text: string };

export const actionRow = (action: Action): ActionRow => ({
  kind: "action",
  key: action.id,
  action,
});

// Once an action is chosen: the words written for it, then its choices that fit them.
export function argumentRows(
  action: Action,
  text: string,
  loaded?: readonly ActionChoice[],
): ActionRow[] {
  const choices = matchChoices(choicesOf(action) ?? loaded ?? [], text).map(
    (choice): ActionRow => ({
      kind: "choice",
      key: `${action.id}:${choice.value}`,
      action,
      choice,
    }),
  );
  return action.input && text.trim()
    ? [{ kind: "text", key: `${action.id}:text`, action, text: text.trim() }, ...choices]
    : choices;
}

// What the slash menu lists for the composer's text: matching commands while the name is typed, then
// the chosen command's choices, or the command itself to say what it takes.
export function slashRows(
  actions: readonly Action[],
  typed: CommandText,
  loaded?: readonly ActionChoice[],
): ActionRow[] {
  if (!typed.spaced) return matchCommands(actions, typed.name).map(actionRow);
  const action = findCommand(actions, typed.name);
  if (!action) return [];
  const rows = argumentRows(action, typed.arg, loaded);
  return rows.length ? rows : [actionRow(action)];
}

// An action is chosen and asks for more: its words, or one of its choices.
export const asksMore = (action: Action) => action.input === "required" || !!action.choices;

// What running a row asks of the action: why it can't run, or what it is given.
export function rowInput(
  row: ActionRow,
  typed?: CommandText,
): { problem: string } | { text: string; choice?: ActionChoice } {
  const { action } = row;
  if (action.unavailable) return { problem: action.unavailable };
  if (row.kind === "choice")
    return row.choice.unavailable
      ? { problem: row.choice.unavailable }
      : { text: "", choice: row.choice };
  if (row.kind === "text") return { text: row.text };
  const text = typed?.spaced ? typed.arg.trim() : "";
  if (action.input === "required" && !text)
    return {
      problem: `Write the ${(action.hint ?? "words").replace(/[<>[\]]/g, "")} after /${action.command}.`,
    };
  if (action.choices && !action.input)
    return { problem: text ? `Nothing matches “${text}”.` : "Choose one from the list." };
  return { text };
}

const RECENT_KEY = "localdot.recent-actions.v1";
const RECENT_MAX = 6;

export function recentActions(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberAction(id: string): void {
  try {
    const next = [id, ...recentActions().filter((seen) => seen !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* Recent actions are a convenience; a blocked store forgets them. */
  }
}

type Fill = (text: string) => void;
const fills = new Set<Fill>();

// Puts words in the composer, focused, as if typed: "/" lists the commands.
export function fillComposer(text: string): void {
  for (const fill of fills) fill(text);
}
export function onComposerFill(fill: Fill): () => void {
  fills.add(fill);
  return () => {
    fills.delete(fill);
  };
}
