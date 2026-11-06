import { expect, it } from "vitest";
import { conversationBlockReason } from "./conversation-state.ts";

it("lets the user leave a conversation whatever its task is doing", () => {
  expect(conversationBlockReason(false)).toBeUndefined();
  expect(conversationBlockReason(true)).toBe("Stopping the current task…");
});
