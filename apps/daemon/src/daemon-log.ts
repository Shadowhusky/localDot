// Keep lifecycle and component logs on the same UTC clock, including messages emitted by modules.
export function timestampLogs(
  target: Pick<Console, "log" | "warn" | "error"> = console,
  now = () => new Date().toISOString(),
): void {
  for (const level of ["log", "warn", "error"] as const) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => write(`[${now()}]`, ...args);
  }
}
