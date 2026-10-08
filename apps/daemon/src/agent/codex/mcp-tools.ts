import {
  ComputerAction,
  MODEL_SCREEN,
  TOOL_INPUTS,
  TOOL_NAMES,
  type ToolName,
  type ToolResult,
} from "@localdot/protocol";
import { z } from "zod";

// The tools Codex sees: exactly the v1 table (spec "Tools"), the same schemas the daemon checks.
// `computer` takes localDot's provider-neutral ComputerAction in model pixels; its `basedOn` is not
// the model's to give (the endpoint uses the full-frame basis explicitly submitted for this turn).
export const CodexComputerInput = ComputerAction.omit({ basedOn: true });

const W = MODEL_SCREEN.width;
const H = MODEL_SCREEN.height;

export const CODEX_TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  computer:
    `Use the virtual computer's screen, a ${W}x${H} Linux desktop. action: screenshot (returns the screen), ` +
    `click (point {x, y} in screen pixels, 0 <= x < ${W}, 0 <= y < ${H}; button left/right/middle; count 1-3), ` +
    "type (text), key (keys: X key names such as Return, Page_Up or plus, several for a combo like ctrl+l; " +
    "repeat up to 100 presses), hold_key (keys, ms up to 30000 to keep them down), scroll (point, dx and dy in " +
    "steps of -30..30), wait (ms), zoom (region {x, y, w, h}, returns that part enlarged), cursor_position. " +
    "Each action can return a new screenshot. Actions in this turn still use its initial full-frame basis. If the screen changed, localDot cancels this turn before any retry.",
  shell:
    "Run one bash command in the virtual computer's terminal, as its user, in their home. Returns the " +
    "exit status and the end of the output.",
  files:
    "Read, write, edit (old_text must match exactly once) or list files in the virtual computer's home. " +
    "Paths are relative to the home or start with ~/.",
  browser_read: "Read the text and structure of the page open on the selected screen.",
  browser_navigate:
    "Open an http or https URL on the selected desktop or signed-in browser screen.",
  browser_upload:
    "Assign 1–10 desktop-home files (100 MiB total maximum) to the currently open file chooser on the isolated browser screen, after explicit approval of the exact files and receiving page. This does not submit the page's form. Never retry an uncertain upload automatically.",
  switch_screen:
    "Switch between desktop and the isolated signed-in browser. Use browser for signed-in work and request_takeover for login. Request a fresh screenshot after switching; shell and files remain on the desktop.",
  update_plan:
    "Replace the task's plan: the whole list of steps, each todo, doing, done or skipped.",
  ask_user:
    "Ask the user a question and wait for the answer (up to 30 minutes). Give up to six short options, " +
    "and set allow_text to accept a free answer.",
  request_takeover:
    "Hand the screen to the user for a login, two-factor code, CAPTCHA or payment, and wait until they " +
    "hand it back. Never type passwords or card numbers yourself.",
  remember:
    "Add to or replace text in USER.md (about the user) or MEMORY.md (facts worth keeping).",
  done: "Finish the task: a summary for the user, and the paths of any files in the home to hand over.",
};

export interface McpToolDescriptor {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function codexTools(): McpToolDescriptor[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: CODEX_TOOL_DESCRIPTIONS[name],
    inputSchema: jsonSchema(name === "computer" ? CodexComputerInput : TOOL_INPUTS[name]),
  }));
}

export interface McpCallResult {
  [key: string]: unknown;
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
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
