(() => {
  const video = [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video) return "no video element found";
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const summary = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    return { n: s.length, p50: +pct(s, 50).toFixed(2), p90: +pct(s, 90).toFixed(2), p99: +pct(s, 99).toFixed(2), max: +s[s.length - 1].toFixed(2) };
  };

  const presented = [];
  const onFrame = (now, meta) => {
    presented.push(performance.timeOrigin + (meta.presentationTime ?? now));
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  const decoded = [];
  const formats = new Set();
  window.ldProbeTrack = async () => {
    const track = video.srcObject.getVideoTracks()[0].clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      decoded.push(Date.now());
      formats.add(`${value.codedWidth}x${value.codedHeight} ${value.format}`);
      value.close();
    }
  };

  const uploads = [];
  window.ldProbeSyncUpload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const gl = canvas.getContext("webgl2", { antialias: false });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    const px = new Uint8Array(4);
    const draw = () => {
      const t0 = performance.now();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, video.videoWidth, video.videoHeight, 0, canvas.height, canvas.width, 0, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      uploads.push([Date.now(), performance.now() - t0]);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  };

  window.ldProbe = (from = 0, to = Infinity, gapMs = 100) => {
    const inWindow = (t) => t >= from && t <= to;
    const frames = presented.filter(inWindow);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).filter((gap) => gap < gapMs);
    const motionMs = gaps.reduce((sum, gap) => sum + gap, 0);
    return {
      presented: frames.length,
      inMotionFps: motionMs ? +((gaps.length * 1000) / motionMs).toFixed(1) : 0,
      motionSeconds: +(motionMs / 1000).toFixed(1),
      gapMs: summary(gaps),
      decoded: decoded.filter(inWindow).length,
      decodedFormats: [...formats],
      syncUploadMs: summary(uploads.filter(([t]) => inWindow(t)).map(([, ms]) => ms)),
    };
  };

  window.ldSelkiesStats = (from = 0, to = Infinity) => {
    const cols = ["encoded_fps", "fps", "mbps", "encode_ms", "pipeline_ms", "decode_ms", "rtt_ms", "throttled"];
    const rows = window.stream_stats.history.filter((s) => s.t >= from && s.t <= to);
    return [["t", ...cols].join(" "), ...rows.map((s) => [(s.t / 1000).toFixed(1), ...cols.map((c) => s[c] ?? "-")].join(" "))].join("\n");
  };

  return `probing ${video.tagName}#${video.id || "(no id)"}`;
})();
