import type { KeydClient } from "../keyd/client.ts";

export type DayLimitKeyd = Partial<Pick<KeydClient, "budget" | "setBudget">>;

// keyd keeps the one daily limit every task shares, and a task's own limit arrives with the task,
// so keyd's default per task stays none. Changing keyd's limits ends the model calls in flight, so
// they change only when they differ from what the user set.
export async function syncDayLimit(keyd: DayLimitKeyd, dayUSD: number | undefined): Promise<void> {
  if (!keyd.budget || !keyd.setBudget) return;
  const now = await keyd.budget();
  const want = dayUSD ?? 0;
  if (now.perTaskUSD !== 0 || now.perDayUSD !== want) await keyd.setBudget(0, want);
}
