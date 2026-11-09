import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SideSpendLedger } from "./agent.ts";

// What side questions cost, beside the task's log and never in it: amounts and models only, no
// question or answer. It goes when the task's record does.
export function sideSpendLedger(logFile: string): SideSpendLedger {
  const file = join(dirname(logFile), "side-spend.jsonl");
  return {
    record: (rows) => {
      if (rows.length)
        appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), {
          mode: 0o600,
        });
    },
    taskUSD: () => {
      if (!existsSync(file)) return 0;
      let total = 0;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const usd = (JSON.parse(line) as { usd?: unknown }).usd;
          if (typeof usd === "number" && Number.isFinite(usd)) total += usd;
        } catch {
          // A line cut short by a crash counts for nothing.
        }
      }
      return total;
    },
  };
}
