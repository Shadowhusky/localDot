import { expect, it } from "vitest";
import { conversationBlockReason } from "./conversation-state.ts";

it("lets the user leave a conversation whatever its task is doing", () => {
  expect(conversationBlockReason(false, false)).toBeUndefined();
  expect(conversationBlockReason(true, false)).toBe("Stopping the current task…");
  expect(conversationBlockReason(false, true)).toBe("Just a moment…");
});
