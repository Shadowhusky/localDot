// Paste into the S8 page (DevTools console or the MCP's evaluate_script) once the stage shows the
// desktop. It times every frame on a second clone of the iframe's track, logs each #stats update,
// and adds two summaries:
//   ldSummary(from, to)  motion between two epoch-ms marks (motion.sh prints them); a frame gap
//                        under 100 ms counts as moving, as in S1's probe.js
//   ldLatency(sent)      send → first frame after each send, for latency-send.mjs's `sent` list
// Re-run it after the client reloads itself: the clone ends with the old track.
(() => {
  const frame = document.getElementById("desktop");
  const statsEl = document.getElementById("stats");
  const track = frame.contentDocument?.getElementById("videoStream")?.srcObject?.getVideoTracks?.()[0];
  if (!track) return "no track yet";
  window.ldRec?.stop();
  const rec = { frames: [], stats: [], trackId: track.id };
  const observer = new MutationObserver(() => {
    try {
      rec.stats.push({ t: Date.now(), ...JSON.parse(statsEl.textContent) });
    } catch {}
  });
  observer.observe(statsEl, { childList: true, characterData: true, subtree: true });
  const clone = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
  let stopped = false;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (!stopped) rec.frames.push(Date.now());
      value.close();
    }
  })();
  rec.stop = () => {
    stopped = true;
    observer.disconnect();
    reader.cancel().catch(() => {});
    clone.stop();
  };
  window.ldRec = rec;

  const pick = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

  window.ldSummary = (from = 0, to = Number.POSITIVE_INFINITY, gapMs = 100) => {
    const f = rec.frames.filter((t) => t >= from && t <= to);
    const moving = [];
    for (let i = 1; i < f.length; i++) if (f[i] - f[i - 1] < gapMs) moving.push(f[i] - f[i - 1]);
    const sorted = moving.slice().sort((a, b) => a - b);
    const movingMs = moving.reduce((a, b) => a + b, 0);
    return {
      frames: f.length,
      firstFrame: f[0] ?? null,
      lastFrame: f.at(-1) ?? null,
      movingSeconds: +(movingMs / 1000).toFixed(2),
      fpsWhileMoving: movingMs ? +((moving.length * 1000) / movingMs).toFixed(1) : null,
      gapP50: pick(sorted, 50),
      gapP90: pick(sorted, 90),
      gapP99: pick(sorted, 99),
      gapMax: sorted.at(-1) ?? null,
      statsFps: rec.stats.filter((x) => x.t >= from && x.t <= to).map((x) => x.fps).join(" "),
    };
  };

  window.ldLatency = (sent) => {
    const latency = [];
    let missing = 0;
    for (let i = 0; i < sent.length; i++) {
      const end = sent[i + 1] ?? sent[i] + 600;
      const first = rec.frames.find((t) => t > sent[i] && t < end);
      if (first === undefined) missing++;
      else latency.push(first - sent[i]);
    }
    const sorted = latency.slice().sort((a, b) => a - b);
    return {
      n: latency.length,
      missing,
      p50: pick(sorted, 50),
      p90: pick(sorted, 90),
      p95: pick(sorted, 95),
      max: sorted.at(-1) ?? null,
      min: sorted[0] ?? null,
      latencyMs: latency.join(" "),
    };
  };
  return `recording ${track.id}`;
})();
