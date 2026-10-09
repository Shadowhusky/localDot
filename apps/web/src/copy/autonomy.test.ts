import { BALANCED_AUTONOMY, CAREFUL_AUTONOMY } from "@localdot/protocol";
import { expect, it } from "vitest";
import { allowedLine, checksSummary, undoAllowedLabel } from "./autonomy.ts";

it("says in words what dot stops to ask about", () => {
  expect(checksSummary(BALANCED_AUTONOMY)).toBe(
    "Asks before buying, sending, posting or deleting.",
  );
  expect(checksSummary(CAREFUL_AUTONOMY)).toBe(
    "Asks before every step in its computer, and before buying, sending, posting or deleting.",
  );
  expect(
    checksSummary({ ...BALANCED_AUTONOMY, purchase: "handoff", post: "act", delete: "act" }),
  ).toBe("Asks before buying or sending.");
  const consequential = { purchase: "act", send: "act", post: "act", delete: "act" } as const;
  expect(checksSummary({ ...BALANCED_AUTONOMY, ...consequential })).toBe("Asks before some steps.");
  expect(
    checksSummary({
      ...BALANCED_AUTONOMY,
      ...consequential,
      download_execute: "act",
      system_settings: "act",
      memory: "act",
    }),
  ).toBe("Works without asking, even when buying, sending, posting or deleting.");
});

it("names the program or destination a connection's choice opened, and how to undo it", () => {
  const task = {
    scope: "task",
    label: "For this task",
    destination: "chat.example.com:5222",
  } as const;
  const app = { scope: "app", label: "Always for wechat", app: "wechat" } as const;
  const place = {
    scope: "destination",
    label: "Always for chat.example.com:5222",
    destination: "chat.example.com:5222",
  } as const;
  expect(allowedLine("network", task)).toBe(
    "Allowed for this task: connections to chat.example.com:5222.",
  );
  expect(allowedLine("network", app)).toBe("Always allowed: connections from wechat.");
  expect(allowedLine("network", place)).toBe(
    "Always allowed: connections to chat.example.com:5222.",
  );
  expect(undoAllowedLabel("network", task)).toBe(
    "Undo allowing connections to chat.example.com:5222 for this task",
  );
  expect(undoAllowedLabel("network", app)).toBe("Undo always allowing connections from wechat");
});
