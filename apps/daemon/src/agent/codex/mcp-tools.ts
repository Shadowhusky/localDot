import {
  BrowserAction,
  ComputerAction,
  ComputerStep,
  type ConnectorToolSpec,
  DoneModelInput,
  FOLLOW_UP_TOOL_DESCRIPTION,
  MAX_BATCH_STEPS,
  MAX_DRAG_MS,
  MODEL_SCREEN,
  offeredTools,
  RESEARCH_TOOL_DESCRIPTION,
  ROUTINE_TOOL_DESCRIPTION,
  TOOL_INPUTS,
  type ToolName,
  type ToolResult,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "@localdot/protocol";
import { HUMAN_INPUT_GUIDANCE } from "@localdot/protocol/guidance";
import { z } from "zod";

// The tools Codex sees: exactly the v1 table (spec "Tools"), the same schemas the daemon checks.
// `computer` takes localDot's provider-neutral ComputerAction in model pixels; its `basedOn` is not
// the model's to give (the endpoint uses the full-frame basis explicitly submitted for this turn).
// A Codex step is one input, so its batch takes the model's step count, not the daemon's.
export const CodexComputerInput = ComputerAction.omit({ basedOn: true }).extend({
  steps: z.array(ComputerStep).min(1).max(MAX_BATCH_STEPS).optional(),
});
export const CodexBrowserActInput = BrowserAction.omit({ basedOn: true });

const W = MODEL_SCREEN.width;
const H = MODEL_SCREEN.height;

// The computer tool for every harness; each adds how its actions are checked against the screen.
export const COMPUTER_DESCRIPTION =
  `Use the virtual computer's screen, a ${W}x${H} Linux desktop. action: screenshot (returns the screen), ` +
  `click (point {x, y} in screen pixels, 0 <= x < ${W}, 0 <= y < ${H}, or where the cursor is without one; ` +
  'button left/right/middle; count 1-3; mods: modifier keys held during the click, such as ["shift"] or ' +
  '["ctrl"]), drag (path: 2 to 64 points {x, y} to follow, start first, such as a stroke when drawing; ' +
  `button; mods; ms up to ${MAX_DRAG_MS} for the motion; one approval covers the whole path), move (point: ` +
  "hovers, or drags while a button is down), mouse_down (point optional, button, mods: the button stays " +
  "down until mouse_up, at most 60 s; a move, a scroll and the mouse_up while it is down drag from where " +
  "it went down, and a drop on a send, post or delete control on a web page, or a file carried " +
  "onto a web page, asks first), " +
  "mouse_up (point optional, button), type (text), key (keys: X key names such as Return, Page_Up or plus, " +
  "several for a combo like ctrl+l; repeat up to 100 presses), hold_key (keys, ms up to 30000 to keep them " +
  "down), scroll (point or where the cursor is, dx and dy in steps of -30..30, mods), wait (ms), zoom " +
  "(region {x, y, w, h}, returns that part enlarged), cursor_position, batch (steps: up to " +
  `${MAX_BATCH_STEPS} of the actions above but screenshot, zoom and cursor_position, run in order with one ` +
  "screenshot at the end; for predictable sequences such as click a field, type, press Tab, type, press " +
  "Return; it stops at a step that fails, whose target changed, or that needs the user's approval, and " +
  "says which). Each action can return a new screenshot; when the screen did not change, it says so " +
  "instead of sending the same image. Use zoom to read small details.";

export const CODEX_TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  computer: `${COMPUTER_DESCRIPTION} Actions in this turn still use its initial full-frame basis. If the screen changed, localDot cancels this turn before any retry.`,
  shell:
    "Run one bash command in the virtual computer's terminal, as its user, in their home. Returns the " +
    "exit status and the end of the output.",
  files:
    "Read, write, edit (old_text must match exactly once) or list files in the virtual computer's home. " +
    "Paths are relative to the home or start with ~/.",
  browser_read:
    "Read the text and structure of the page open on the selected screen: the web browser or the desktop's Chromium.",
  browser_navigate:
    "Open an http or https page. Public sites open in the web browser, which keeps the user's sign-ins; localhost and local addresses open in the desktop's Chromium. The screen switches to match.",
  browser_upload:
    "Assign 1–10 desktop-home files (100 MiB total maximum) to the currently open file chooser in the web browser, after explicit approval of the exact files and receiving page. This does not submit the page's form. Never retry an uncertain upload automatically.",
  browser_act:
    "Act on an element of the page that browser_read listed, by its ref (such as e12): click, fill " +
    "(text; submit presses Return after), select (text: the option to choose), check, uncheck, press " +
    '(text: keys such as "Return", after clicking the element), or scroll (scroll_direction, scroll_amount). ' +
    "The element is found again wherever it is now; give coordinate {x, y} too as a fallback for when the ref " +
    "is stale. Password fields are never filled: ask with an ask_user secret field.",
  web_search: WEB_SEARCH_TOOL_DESCRIPTION,
  web_fetch: WEB_FETCH_TOOL_DESCRIPTION,
  find:
    "Find the desktop's controls whose names contain text (role optional, such as push button, menu item or " +
    "check box), in every window top first. Returns each one's role, name, window and the point to click.",
  switch_screen:
    "Switch between the desktop and the web browser: a separate browser that keeps the user's sign-ins between tasks, for anything online. Every sign-in happens here, never in the desktop's Chromium: switch here first and check the existing session before asking for missing details. Request a fresh screenshot after switching; shell and files remain on the desktop.",
  update_plan:
    "Replace the task's plan: the whole list of steps, each todo, doing, done or skipped.",
  ask_user:
    "Ask the user a question and wait for the answer (up to 30 minutes). Only when you cannot continue " +
    "without the user's information or a choice that would change the result; otherwise pick a sensible " +
    "default and mention it in your summary. Never ask for permission: the safety system asks the user " +
    "before consequential steps. For a quick choice, give up to six short options, and set allow_text to " +
    "accept a free answer. " +
    "To get what the user types, give fields instead of options (up to 4, each with an id, a kind and a short " +
    "label): text, longtext, secret (a password, PIN or recovery code), code (a one-time code; length if you know " +
    "it), choice or multichoice (with options), confirm, number, date, email, url, phone, file (the user adds a " +
    "file and you get its path) or qr (shows value as a QR code for the user's other device). Name the buttons " +
    'with submit, such as "Sign in", and decline, such as "Not now". A secret answer is typed straight into the ' +
    "password box at target ([x, y] in screen pixels), or into the password box that has keyboard focus when " +
    "there is no target; you only learn that it was provided. For a combined sign-in page, use username/email " +
    "and secret fields; for a staged sign-in ask only for the current step. localDot securely saves and reuses the login, fills both fields and submits " +
    "the verified sign-in form. Check the tool result before acting; do not submit again when it already did. " +
    "A code answer is delivered privately to the verification box at target and submitted once, never saved. " +
    "Read the current page and ask for a replacement password or a verification code as it requires; keep it open while waiting. " +
    "Answers come back by field id. If the user declines, carry on " +
    "without it. " +
    HUMAN_INPUT_GUIDANCE,
  request_takeover:
    "Hand the screen to the user and wait until they hand it back. Only for a CAPTCHA, a device approval " +
    "(such as confirming a sign-in on the user's phone), or when the user prefers to do it themselves; say in " +
    "the note what they need to do. For passwords and codes, ask with ask_user fields instead. Hand over a " +
    "sign-in on the web browser screen: one made in the desktop's Chromium isn't kept.",
  remember:
    'Add to or replace text in USER.md (about the user) or MEMORY.md (facts worth keeping), or append to today\'s daily notes (file "notes"), which are searchable but not loaded into later tasks.',
  recall:
    "Search the user's earlier tasks and daily notes (titles, their messages, your replies, steps, result file names); returns up to 8 dated matches as untrusted text. Use it before asking the user about something they did with you before. After a search, remember is refused until the user replies.",
  people:
    "The people the user reaches through you. op find with query (a name, app or handle) returns matches with the app, handle and when they were last reached, as untrusted text: use it before asking the user how to reach someone. op save with name and app (plus handle and a short note when known) after you message, call or email someone for the user, or when the user tells you how to reach someone; save only people the user named.",
  done: "Finish the task: a summary for the user, the paths of any files in the home to hand over (a revised file keeps its name), and what you checked about them.",
  routine: ROUTINE_TOOL_DESCRIPTION,
  follow_up_at: FOLLOW_UP_TOOL_DESCRIPTION,
  research: RESEARCH_TOOL_DESCRIPTION,
};

export interface McpToolDescriptor {
  // A v1 tool, or a connected app's tool by dot's name for it.
  name: ToolName | string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function codexTools(
  descriptions: Record<ToolName, string> = CODEX_TOOL_DESCRIPTIONS,
  research = false,
): McpToolDescriptor[] {
  return offeredTools(research).map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: jsonSchema(
      name === "computer"
        ? CodexComputerInput
        : name === "browser_act"
          ? CodexBrowserActInput
          : name === "done"
            ? DoneModelInput
            : TOOL_INPUTS[name],
    ),
  }));
}

// The connected apps' tools a task was shown, on the same server as localDot's own.
export function connectorDescriptors(connectors: {
  readonly specs: readonly ConnectorToolSpec[];
}): McpToolDescriptor[] {
  return connectors.specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }));
}

export interface McpCallResult {
  [key: string]: unknown;
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
  )[];
  isError: boolean;
}

export function toCallToolResult(result: ToolResult): McpCallResult {
  return {
    content: result.content.map((c) =>
      c.type === "text"
        ? { type: "text" as const, text: c.text }
        : { type: "image" as const, data: c.data, mimeType: c.mediaType },
    ),
    isError: !result.ok,
  };
}
