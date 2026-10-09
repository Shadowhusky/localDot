export interface DaemonStartup {
  stopping(): boolean;
  restorePrepared(): Promise<void>;
  recoverBrowsers(): Promise<void>;
  containFenced(): Promise<void>;
  startAgent(): Promise<void>;
  recoverReplacements(): Promise<void>;
  reconcile(): Promise<void>;
  restoreResets(): Promise<void>;
  openResets(): void;
}

/** Every step runs even after an earlier one failed. A failed step leaves its own durable holds
 * in place and later steps re-check admission themselves, so one held computer cannot keep the
 * rest of the daemon from recovering. Rejects at the end so managed readiness still fails. */
export async function runDaemonStartup(
  s: DaemonStartup,
  log: (line: string) => void = console.error,
): Promise<void> {
  const failed: string[] = [];
  const step = async (name: string, run: () => Promise<void>) => {
    if (s.stopping()) {
      failed.push(name);
      return;
    }
    try {
      await run();
    } catch (error) {
      failed.push(name);
      log(`startup: ${name} failed (${describeStartupError(error)})`);
    }
  };
  await step("runtime update recovery", s.restorePrepared);
  await step("browser recovery", s.recoverBrowsers);
  await step("fenced computer containment", s.containFenced);
  await step("agent start", s.startAgent);
  await step("replacement recovery", s.recoverReplacements);
  // Reset recovery republishes only freshly verified candidates, so it follows reconcile.
  await step("computer reconcile", s.reconcile);
  await step("reset recovery", s.restoreResets);
  if (!s.stopping()) s.openResets();
  if (failed.length) throw new Error(`startup incomplete: ${failed.join(", ")}`);
}

/** Docker and filesystem errors can quote request paths or credentials; keep cell ids only. */
export function describeStartupError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .replace(/(^|[\s'"`(=:])~?\/\S*/g, "$1<path>")
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, "<redacted>")
      .slice(0, 400) || "no detail"
  );
}
