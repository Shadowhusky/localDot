import { expect, it, vi } from "vitest";
import { KeydError } from "../keyd/client.ts";
import { openConnectorListener } from "./open-listener.ts";

it("uses identical web egress and secret bindings with an older key service", async () => {
  const request = {
    cellId: "connector-github",
    role: "connector" as const,
    port: 4780,
    secrets: ["connector-github"],
  };
  const openCell = vi
    .fn()
    .mockRejectedValueOnce(
      new KeydError(400, "bad-request", 'policy: unknown role "connector"', "/v1/cells"),
    )
    .mockResolvedValue({ cellId: request.cellId });
  await openConnectorListener({ openCell }, request);
  expect(openCell.mock.calls).toEqual([[request], [{ ...request, role: "desktop" }]]);
});
it("does not retry key, authorization or network failures with another role", async () => {
  const error = new KeydError(403, "denied", "no", "/v1/cells");
  const openCell = vi.fn().mockRejectedValue(error);
  await expect(
    openConnectorListener(
      { openCell },
      { cellId: "connector-test", role: "connector", port: 4780, secrets: [] },
    ),
  ).rejects.toBe(error);
  expect(openCell).toHaveBeenCalledTimes(1);
});
