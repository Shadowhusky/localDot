import { anthropic } from "@ai-sdk/anthropic";
import {
  AskUserInput,
  BrowserNavigateInput,
  BrowserReadInput,
  DoneInput,
  FilesInput,
  GenericComputerInput,
  type ModelBinding,
  RememberInput,
  RequestTakeoverInput,
  ShellInput,
  UpdatePlanInput,
} from "@localdot/protocol";
import { type ToolSet, tool } from "ai";

const GENERIC_ACTIONS =
  'Actions: screenshot; left_click, right_click, middle_click, double_click, triple_click (coordinate); type (text); key (text, e.g. "ctrl+s" or "Return"; repeat); scroll (coordinate, scroll_direction, scroll_amount); wait (duration in seconds); zoom (region [x0, y0, x1, y1]); cursor_position.';

function computerTool(b: ModelBinding) {
  switch (b.computer) {
    case "anthropic-toolset":
      return anthropic.tools.computerToolset_20260801({});
    case "anthropic-legacy":
      return anthropic.tools.computer_20250124({
        displayWidthPx: 1280,
        displayHeightPx: 800,
      });
    case "generic":
      // S5 and D9: Gemini and Qwen answer on the 0–1000 grid even when told pixels, so it is the
      // grid they are told about; telling them pixels only costs accuracy.
      return tool({
        description:
          b.coords === "per1000"
            ? `Operate the computer's 1280x800 screen. Coordinates are [x, y] on a 0-1000 grid relative to the screen's width and height (0,0 top-left, 1000,1000 bottom-right). ${GENERIC_ACTIONS}`
            : `Operate the computer's 1280x800 screen. Coordinates are [x, y] in screenshot pixels (0,0 top-left). ${GENERIC_ACTIONS}`,
        inputSchema: GenericComputerInput,
      });
    case "none":
      return undefined;
  }
}

// The v1 tool table (spec "Tools"), without M7's switch_screen. No tool has an execute function:
// the loop runs every call through the daemon's tool API itself.
export function toolSet(b: ModelBinding): ToolSet {
  const computer = b.vision ? computerTool(b) : undefined;
  return {
    ...(computer ? { computer } : {}),
    shell: tool({
      description:
        "Run a bash command in the computer (Ubuntu, your home is ~). Output is returned; long output is cut to its end. Use it for files, installs, data work and anything faster than the GUI.",
      inputSchema: ShellInput,
    }),
    files: tool({
      description:
        "Read, write, edit (replace old_text, which must occur exactly once, with new_text) or list files in the computer's home folder.",
      inputSchema: FilesInput,
    }),
    browser_read: tool({
      description:
        "Read the text and outline of the page open in the computer's Chromium. Faster than screenshots for reading.",
      inputSchema: BrowserReadInput,
    }),
    browser_navigate: tool({
      description:
        "Open a URL in the computer's Chromium (starting it if needed) and get a screenshot.",
      inputSchema: BrowserNavigateInput,
    }),
    update_plan: tool({
      description:
        "Set the task's checklist: the whole list each time, with each item's status. Keep it short; update it as you go.",
      inputSchema: UpdatePlanInput,
    }),
    ask_user: tool({
      description:
        "Ask the user a question and wait for the answer. Offer up to six short options when you can.",
      inputSchema: AskUserInput,
    }),
    request_takeover: tool({
      description:
        "Hand the screen to the user for a login, 2FA, a CAPTCHA or a payment. You never type credentials or card numbers yourself.",
      inputSchema: RequestTakeoverInput,
    }),
    remember: tool({
      description:
        "Save a lasting fact: USER.md for who the user is and their preferences, MEMORY.md for other facts worth keeping. The user sees every change and can undo it.",
      inputSchema: RememberInput,
    }),
    done: tool({
      description:
        "Finish the task: a summary for the user, and the paths of any files in the computer they should get.",
      inputSchema: DoneInput,
    }),
  };
}
