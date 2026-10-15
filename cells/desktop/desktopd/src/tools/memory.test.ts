import { describe, expect, it } from "vitest";
import { desktopMemory } from "./memory.ts";

const values: Record<string, string> = {
  "memory.current": "950",
  "memory.max": "1000",
  "memory.stat": "inactive_file 200\n",
  "memory.events": "oom 11\noom_kill 4\n",
  "memory.swap.current": "2",
  "memory.swap.max": "100",
};
function reader(overrides: Record<string, string> = {}) {
  const v = { ...values, ...overrides };
  return async (p: string) => {
    const s = v[p.split("/").at(-1)!];
    if (s === undefined) throw new Error("unavailable");
    return s;
  };
}
describe("container memory evidence", () => {
  it("discounts reclaimable file cache and preserves cumulative OOM evidence", async () => {
    expect(await desktopMemory(reader())).toEqual({
      currentBytes: 950,
      workingSetBytes: 750,
      limitBytes: 1000,
      pressure: "normal",
      oomKills: 4,
      swapBytes: 2,
      swapLimitBytes: 100,
    });
  });
  it.each([
    [800, "high"],
    [900, "critical"],
  ])("reports %i working bytes as %s pressure", async (usage, pressure) => {
    expect(
      await desktopMemory(
        reader({ "memory.current": String(usage), "memory.stat": "inactive_file 0" }),
      ),
    ).toMatchObject({ pressure });
  });
  it.each(["max", "0", "-1", "NaN", "9007199254740993"])(
    "keeps invalid/unbounded limit %s unknown",
    async (limit) => {
      expect(await desktopMemory(reader({ "memory.max": limit }))).toBeUndefined();
    },
  );
  it("does not report zero OOMs when counters cannot be read", async () => {
    expect(await desktopMemory(reader({ "memory.events": "unavailable" }))).toBeUndefined();
    expect(
      await desktopMemory(async () => {
        throw new Error("unsupported");
      }),
    ).toBeUndefined();
  });
});

it("detects VM starvation independently of a healthy desktop cgroup", async () => {
  const memory = await desktopMemory(
    reader({
      meminfo: "MemTotal:       8000000 kB\nMemAvailable:    100000 kB\n",
      memory:
        "some avg10=30.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=25.10 avg60=0.00 avg300=0.00 total=1\n",
    }),
  );
  expect(memory?.pressure).toBe("normal");
  expect(memory?.vm).toMatchObject({
    totalBytes: 8192000000,
    availableBytes: 102400000,
    stallPercent10s: 25.1,
    pressure: "critical",
  });
});
it("does not invent VM health when kernel metrics are missing or invalid", async () => {
  expect((await desktopMemory(reader()))?.vm).toBeUndefined();
  expect(
    (await desktopMemory(reader({ meminfo: "MemTotal: 10 kB\nMemAvailable: 20 kB\n" })))?.vm,
  ).toBeUndefined();
});
