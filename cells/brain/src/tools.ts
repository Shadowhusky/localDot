import { anthropic } from "@ai-sdk/anthropic";
import {
  AskUserInput,
  BrowserNavigateInput,
  BrowserReadInput,
  BrowserUploadInput,
  DoneInput,
  FilesInput,
  GenericComputerInput,
  type ModelBinding,
  RememberInput,
  RequestTakeoverInput,
  ShellInput,
  SwitchScreenInput,
  UpdatePlanInput,
} from "@localdot/protocol";
import { type ToolSet, tool } from "ai";

const GENERIC_ACTIONS =
  'Actions: screenshot; left_click, right_click, middle_click, double_click, triple_click (coordinate, or where the cursor is without one; text holds modifier keys down during the click, e.g. "shift" or "ctrl+shift"); left_click_drag (start_coordinate and coordinate, or path: 2 to 64 [x, y] points to follow, such as a stroke when drawing; optional button, text modifiers and duration up to 10 seconds; one approval covers the whole path); mouse_move (coordinate: hovers, or drags while a button is down); left_mouse_down and left_mouse_up (optional coordinate and button; the button stays down until left_mouse_up, at most 60 seconds; a mouse_move, a scroll and the left_mouse_up while it is down drag from where it went down, and a drop on a send, post or delete control on a web page, or a file carried onto a web page, asks first); type (text; optional coordinate to click first, clear to select all and delete first, submit to press Return after); key (text: X key names joined by +, e.g. "ctrl+s", "Return", "Page_Up", "ctrl++"; repeat up to 100 presses); hold_key (text, duration up to 30 seconds); scroll (coordinate or where the cursor is, scroll_direction, scroll_amount, text modifiers); wait (duration in seconds); zoom (region [x0, y0, x1, y1]); cursor_position.';

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

// The v1 tool table (spec "Tools"). No tool has an execute function:
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
        "Read the text and outline of the page open on the selected screen: the web browser or the desktop's Chromium. Faster than screenshots for reading.",
      inputSchema: BrowserReadInput,
    }),
    browser_navigate: tool({
      description:
        "Open an http or https page and get a screenshot. Public sites open in the web browser, which keeps the user's sign-ins; localhost and local addresses open in the desktop's Chromium. The screen switches to match.",
      inputSchema: BrowserNavigateInput,
    }),
    browser_upload: tool({
      description:
        "Assign desktop files to the currently open file chooser in the web browser. First open the page's file picker. Supply 1–10 paths inside the desktop home, at most 100 MiB total. The user must approve the exact files and receiving page. This assigns the files; a page may still require Submit. Never retry an uncertain upload automatically.",
      inputSchema: BrowserUploadInput,
    }),
    update_plan: tool({
      description:
        "Set the task's checklist: the whole list each time, with each item's status. Keep it short; update it as you go.",
      inputSchema: UpdatePlanInput,
    }),
    switch_screen: tool({
      description:
        "Switch between the desktop and the web browser: a separate browser that keeps the user's sign-ins between tasks, for anything online. When a site needs the user to sign in, ask for the details with ask_user fields. After switching, request a screenshot before GUI input. Shell and files always remain on the desktop.",
      inputSchema: SwitchScreenInput,
    }),
    ask_user: tool({
      description:
        'Ask the user a question and wait for the answer. Only when you cannot continue without the user\'s information or a choice that would change the result; otherwise pick a sensible default and mention it in your summary. Never ask for permission: the safety system asks the user before consequential steps. For a quick choice, offer up to six short options. To get what the user types, give fields instead of options (up to 4, each with an id, a kind and a short label): text, longtext, secret (a password, PIN or recovery code), code (a one-time code; length if you know it), choice or multichoice (with options), confirm, number, date, email, url, phone, file (the user adds a file and you get its path) or qr (shows value as a QR code for the user\'s other device). Name the buttons with submit, such as "Sign in", and decline, such as "Not now". A secret answer is typed straight into the field at target ([x, y] in the computer tool\'s coordinates), or into the field that has keyboard focus when there is no target; you only learn that it was provided. Answers come back by field id. If the user declines, carry on without it.',
      inputSchema: AskUserInput,
    }),
    request_takeover: tool({
      description:
        "Hand the screen to the user. Only for a CAPTCHA, a device approval (such as confirming a sign-in on the user's phone), or when the user prefers to do it themselves; say in the note what they need to do. For passwords and codes, ask with ask_user fields instead.",
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
