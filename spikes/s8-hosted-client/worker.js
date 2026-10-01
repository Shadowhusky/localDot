let canvas = null;
let ctx = null;
let presented = 0;
let seeded = 0;
let windowStart = 0;
let windowFrames = 0;
let fps = 0;
let format = null;

function present(frame) {
  format = frame.format;
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
  presented += 1;
}

const report = () =>
  self.postMessage({ presented, seeded, fps, size: `${canvas.width}x${canvas.height}`, format });

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    canvas = m.canvas;
    ctx = canvas.getContext("2d");
    return;
  }
  if (m.type !== "frames") return;
  if (m.first) {
    present(m.first);
    seeded += 1;
    report();
  }
  const reader = m.readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    present(frame);
    windowFrames += 1;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      fps = Math.round((windowFrames * 1000) / (now - windowStart));
      windowFrames = 0;
      windowStart = now;
      report();
    }
  }
};
