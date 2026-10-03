// Every owned fixture resource gets a cleanup attempt even when an earlier cleanup rejects.
// Callers delete their evidence/home only after this confirms all resource cleanup succeeded.
export async function cleanupAcceptance(
  actions: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "owned acceptance cleanup uncertain");
}
