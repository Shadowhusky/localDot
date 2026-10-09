import { type CodexInstructionsInput, nativeInstructions } from "../codex/instructions.ts";

export function claudeCodeInstructions(input: CodexInstructionsInput): string {
  return nativeInstructions(input, {
    tools:
      "Claude Code's own tools are switched off: never spawn sub-agents, and do the work yourself.",
    screen:
      "The task starts with a full 1280x800 screenshot. GUI actions are checked against the newest full screenshot you had seen; if the screen changed, the action is not done and a fresh screenshot comes back, so decide again from it.",
  });
}
