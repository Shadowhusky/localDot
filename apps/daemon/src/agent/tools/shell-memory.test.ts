import { expect, it } from "vitest";
import { toolHarness } from "../testing/harness.ts";

it("warns about a renderer OOM even when the shell command succeeds", async () => {
  const h = toolHarness();
  try {
    h.desktop.shellDone = { exitCode: 0, oomKillsDuringCommand: 1 };
    const result = await h.call("shell", { command: "echo ready" });
    expect(result.body.ok).toBe(true);
    expect(JSON.stringify(result.body)).toContain("kernel killed 1 process");
    expect(JSON.stringify(result.body)).toContain("Do not reset its profile");
  } finally {
    h.close();
  }
});
it("does not misattribute old OOM counters to a successful command", async () => {
  const h = toolHarness();
  try {
    h.desktop.shellDone = {
      exitCode: 0,
      oomKillsDuringCommand: 0,
      memory: {
        currentBytes: 10,
        workingSetBytes: 10,
        limitBytes: 100,
        oomKills: 11,
        pressure: "normal",
      },
    };
    const result = await h.call("shell", { command: "echo ready" });
    expect(result.body.ok).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("kernel killed");
  } finally {
    h.close();
  }
});
