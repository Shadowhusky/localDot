let canvas = null;
let ctx = null;
let presented = 0;
let windowStart = 0;
let windowFrames = 0;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    canvas = m.canvas;
    ctx = canvas.getContext("2d");
    return;
  }
  if (m.type !== "frames") return;
  const reader = m.readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    const format = frame.format;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    presented += 1;
    windowFrames += 1;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      const fps = Math.round((windowFrames * 1000) / (now - windowStart));
      windowFrames = 0;
      windowStart = now;
      self.postMessage({ presented, fps, size: `${canvas.width}x${canvas.height}`, format });
    }
  }
};
