import { type KeydClient, KeydError } from "../keyd/client.ts";

export type DayLimitKeyd = Partial<Pick<KeydClient, "budget" | "setBudget">>;

// A keyd from before a limit could be none (0), or before it kept limits at all, refuses and keeps
// its own limits. The next task start or settings save tries again, so it takes once keyd is
// upgraded.
const OLDER_KEYD = new Set([400, 404, 405]);

// keyd keeps the one daily limit every task shares, and a task's own limit arrives with the task,
// so keyd's default per task stays none. Changing keyd's limits ends the model calls in flight, so
// they change only when they differ from what the user set.
export async function syncDayLimit(keyd: DayLimitKeyd, dayUSD: number | undefined): Promise<void> {
  if (!keyd.budget || !keyd.setBudget) return;
  try {
    const now = await keyd.budget();
    const want = dayUSD ?? 0;
    if (now.perTaskUSD !== 0 || now.perDayUSD !== want) await keyd.setBudget(0, want);
  } catch (error) {
    if (error instanceof KeydError && OLDER_KEYD.has(error.status)) return;
    throw error;
  }
}
