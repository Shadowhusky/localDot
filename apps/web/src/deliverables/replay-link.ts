// Opens Replay at a moment the way a ?replay=&t= link does: the shell restores the task from the
// address on popstate, and Replay reads t when it loads. An export request names the part of the
// recording to export, from and to in ms.
export function openReplay(
  sessionId: string,
  opts: { tMs?: number; exportRange?: { fromMs: number; toMs: number } } = {},
): void {
  const url = new URL(window.location.href);
  const fromWatch = !url.searchParams.has("replay");
  url.searchParams.set("replay", sessionId);
  if (opts.tMs === undefined) url.searchParams.delete("t");
  else url.searchParams.set("t", String(Math.max(0, Math.round(opts.tMs))));
  const range = opts.exportRange;
  if (range)
    url.searchParams.set(
      "export",
      `${Math.max(0, Math.round(range.fromMs))}-${Math.max(0, Math.round(range.toMs))}`,
    );
  else url.searchParams.delete("export");
  // Back from Replay returns to Watch, as when Replay is opened from the top bar.
  window.history.pushState(fromWatch ? { fromWatch: true } : window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// The part of the recording an address asks Replay to export, if it asks.
export function exportRequest(search: string): { fromMs: number; toMs: number } | null {
  const match = /^(\d{1,12})-(\d{1,12})$/.exec(new URLSearchParams(search).get("export") ?? "");
  if (!match) return null;
  const fromMs = Number(match[1]);
  const toMs = Number(match[2]);
  return toMs > fromMs ? { fromMs, toMs } : null;
}

// The asked-for part inside what the recording holds, or null when none of it is there.
export function withinRecording(
  whole: { fromMs: number; toMs: number },
  range: { fromMs: number; toMs: number },
): { fromMs: number; toMs: number } | null {
  const fromMs = Math.max(whole.fromMs, range.fromMs);
  const toMs = Math.min(whole.toMs, range.toMs);
  return toMs > fromMs ? { fromMs, toMs } : null;
}
