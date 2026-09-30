(() => {
  const video = document.querySelector("video#videoStream")
    ?? [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video?.srcObject) return "no video stream found";
  // ldDetect.rect is in frame pixels (default: 32x32 at the centre); a flip is the mean luma crossing threshold.
  // ldDetect.extra (optional) lists more rects whose mean luma is logged per frame, for diagnosis.
  const cfg = (window.ldDetect ??= { rect: null, threshold: 128, extra: [] });
  const wall = () => performance.timeOrigin + performance.now();
  const post = (body) => fetch("http://127.0.0.1:4795/", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  const frames = [];
  const presented = [];
  const flipTs = new Set();
  let buf = new Uint8Array(0);
  let last = null;
  let skew = null;

  const reader = new MediaStreamTrackProcessor({ track: video.srcObject.getVideoTracks()[0].clone() }).readable.getReader();
  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      const at = wall();
      const { width, height } = frame.visibleRect;
      const rect = cfg.rect ?? { x: (width >> 1) - 16, y: (height >> 1) - 16, width: 32, height: 32 };
      const meanLuma = async (r) => {
        const size = frame.allocationSize({ rect: r });
        if (buf.byteLength < size) buf = new Uint8Array(size);
        const [luma] = await frame.copyTo(buf, { rect: r });
        let sum = 0;
        for (let row = 0; row < r.height; row++) {
          const o = luma.offset + row * luma.stride;
          for (let col = 0; col < r.width; col++) sum += buf[o + col];
        }
        return sum / (r.width * r.height);
      };
      // Selkies stamps each chunk with performance.now() * 1e3 when it arrives on the page, before decoding.
      const entry = { at, ts: frame.timestamp, received: performance.timeOrigin + frame.timestamp / 1000, format: frame.format, y: 0 };
      entry.y = await meanLuma(rect);
      if (cfg.extra?.length) {
        entry.extra = [];
        for (const r of cfg.extra) entry.extra.push(await meanLuma(r));
      }
      frame.close();
      const prev = frames.at(-1);
      frames.push(entry);
      const bright = entry.y > cfg.threshold;
      if (last !== null && bright !== last) {
        post({ kind: "flip", ...entry, bright, i: frames.length - 1, prevAt: prev?.at, skew });
        const shown = presented.findLast((p) => p.ts === entry.ts);
        if (shown) post({ kind: "presented", ...shown });
        else flipTs.add(entry.ts);
      }
      last = bright;
    }
  })();

  const onPresented = (now, meta) => {
    const p = { cb: performance.timeOrigin + now, expected: performance.timeOrigin + meta.expectedDisplayTime,
      presentation: performance.timeOrigin + meta.presentationTime, ts: Math.round(meta.mediaTime * 1e6), count: meta.presentedFrames };
    presented.push(p);
    if (flipTs.delete(p.ts)) post({ kind: "presented", ...p });
    video.requestVideoFrameCallback(onPresented);
  };
  video.requestVideoFrameCallback(onPresented);

  window.ldDetectFrames = () => frames;
  window.ldDetectPresented = () => presented;
  // performance.now()'s wall clock minus Date.now(), read at each Date.now() tick edge for 20 ms. It blocks the
  // page for those 20 ms, so it runs once here and otherwise only on demand, never during a run.
  window.ldClockSkew = () => {
    const d = [];
    let prev = Date.now();
    for (const stop = wall() + 20; wall() < stop; ) {
      const t = Date.now();
      if (t !== prev) d.push(wall() - t);
      prev = t;
    }
    return d.reduce((a, b) => a + b, 0) / d.length;
  };
  skew = window.ldClockSkew();
  return `detecting on ${video.tagName}#${video.id} ${video.videoWidth}x${video.videoHeight}, visibility ${document.visibilityState}`;
})();
