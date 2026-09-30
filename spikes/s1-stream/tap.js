(() => {
  const candidates = [...document.querySelectorAll("video, canvas")].filter((el) => el.id !== "ld-tap");
  const source = candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!source) return "no video/canvas element found";
  const out = document.createElement("canvas");
  out.id = "ld-tap";
  out.width = 640;
  out.height = 400;
  Object.assign(out.style, { position: "fixed", right: "8px", bottom: "8px", zIndex: 99999, border: "2px solid #0af" });
  document.body.appendChild(out);
  const gl = out.getContext("webgl2", { antialias: false });
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  const fb = gl.createFramebuffer();
  const times = [];
  const draw = () => {
    const t0 = performance.now();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, source.width || source.videoWidth, source.height || source.videoHeight, 0, out.height, out.width, 0, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    times.push(performance.now() - t0);
    if (times.length > 300) times.shift();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  window.ldTapStats = () => ({
    source: `${source.tagName} ${source.width || source.videoWidth}x${source.height || source.videoHeight}`,
    uploadMsP50: times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)],
  });
  return `tapping ${source.tagName}#${source.id || "(no id)"}`;
})();
