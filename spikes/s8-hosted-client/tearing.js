// Reads every decoded frame from a second clone of the iframe's track, finds the bar's left edge in
// 8 rows between 20 % and 80 % of the frame's height (below the panel and Chromium's toolbar,
// above the dock) and calls a frame torn when two rows disagree by more than 4 px per scale step.
//   ldTear.summary()  frames seen, frames with the bar in every row, moving frames, torn frames
//   ldTear.stop()     ends the clone
// Re-run it after the client reloads itself: the clone ends with the old track.
(() => {
  const track = document
    .getElementById("desktop")
    .contentDocument?.getElementById("videoStream")
    ?.srcObject?.getVideoTracks?.()[0];
  if (!track) return "no track yet";
  window.ldTear?.stop();
  const ROWS = 8;
  const rec = { frames: 0, withBar: 0, moving: 0, torn: [], lastEdge: null, stopped: false };
  const clone = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();

  const edgesOf = async (frame) => {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const edges = [];
    for (let i = 0; i < ROWS; i++) {
      // Even rows, two high: a 4:2:0 frame (LOCALDOT_STREAM_FULLCOLOR=0) refuses odd rects.
      const y = 2 * Math.round((h * (0.2 + (0.6 * i) / (ROWS - 1))) / 2);
      const rect = { x: 0, y, width: w, height: 2 };
      const buf = new Uint8Array(frame.allocationSize({ rect }));
      const [luma] = await frame.copyTo(buf, { rect });
      const row = buf.subarray(luma.offset, luma.offset + w);
      edges.push(row.findIndex((v) => v > 128));
    }
    return { edges, scale: w / 1280 };
  };

  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      try {
        if (rec.stopped) continue;
        const { edges, scale } = await edgesOf(frame);
        rec.frames += 1;
        if (edges.some((e) => e < 0)) continue;
        rec.withBar += 1;
        const spread = Math.max(...edges) - Math.min(...edges);
        if (spread > 4 * scale) rec.torn.push({ frame: rec.frames, edges });
        if (rec.lastEdge !== null && edges[0] !== rec.lastEdge) rec.moving += 1;
        rec.lastEdge = edges[0];
      } finally {
        frame.close();
      }
    }
  })();

  rec.stop = () => {
    rec.stopped = true;
    reader.cancel().catch(() => {});
    clone.stop();
  };
  rec.summary = () => ({
    frames: rec.frames,
    withBar: rec.withBar,
    moving: rec.moving,
    torn: rec.torn.length,
    examples: rec.torn.slice(0, 5),
  });
  window.ldTear = rec;
  return `watching ${track.id}`;
})();
