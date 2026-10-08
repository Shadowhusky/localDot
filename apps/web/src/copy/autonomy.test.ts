import { BALANCED_AUTONOMY, CAREFUL_AUTONOMY } from "@localdot/protocol";
import { expect, it } from "vitest";
import { checksSummary } from "./autonomy.ts";

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
