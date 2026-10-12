import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// One studio, one camera. Scroll reveals the same objects from authored poses.
export async function createWorld(canvas, readState) {
  const renderer = new T.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(36, 1, 0.1, 60);
  const studio = new T.Group();
  scene.add(studio);
  scene.add(new T.HemisphereLight(0xe9f1ff, 0x18202b, 2.5));
  const key = new T.DirectionalLight(0xffffff, 4);
  key.position.set(-3, 5, 6);
  scene.add(key);
  const rim = new T.DirectionalLight(0xa8e5fa, 2.8);
  rim.position.set(5, 1, -2);
  scene.add(rim);
  const pearl = new T.MeshPhysicalMaterial({
    color: 0xe5e8ee,
    roughness: 0.27,
    clearcoat: 0.65,
    clearcoatRoughness: 0.24,
  });
  const eyeMaterial = new T.MeshPhysicalMaterial({
    color: 0x090d13,
    roughness: 0.2,
    clearcoat: 0.8,
  });
  const graphite = new T.MeshStandardMaterial({ color: 0x222d36, roughness: 0.4, metalness: 0.45 });
  const accent = new T.MeshBasicMaterial({ color: 0x9edeea });
  const dot = new T.Group();
  dot.name = "pearl-mascot";
  studio.add(dot);
  dot.add(new T.Mesh(new T.SphereGeometry(0.8, 56, 40), pearl));
  const face = new T.Group();
  dot.add(face);
  const eyes = [-1, 1].map((sign) => {
    const eye = new T.Mesh(new T.CapsuleGeometry(0.059, 0.12, 5, 12), eyeMaterial);
    eye.position.set(sign * 0.17, 0.065, 0.775);
    face.add(eye);
    return eye;
  });
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 1, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,.65)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const shadowTexture = new T.CanvasTexture(shadowCanvas);
  const shadow = new T.Mesh(
    new T.PlaneGeometry(2.8, 1),
    new T.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
  );
  shadow.position.set(0, -1.05, -0.9);
  dot.add(shadow);
  const tasks = new T.Group();
  tasks.name = "work-windows";
  studio.add(tasks);
  const windowGeometry = new RoundedBoxGeometry(2.25, 1.45, 0.13, 3, 0.07);
  const lineGeometry = new T.BoxGeometry(1, 0.025, 0.008);
  const windows = Array.from({ length: 3 }, (_, i) => {
    const group = new T.Group();
    tasks.add(group);
    group.add(new T.Mesh(windowGeometry, graphite));
    const screen = new T.Mesh(
      new RoundedBoxGeometry(2.06, 1.19, 0.015, 2, 0.025),
      new T.MeshBasicMaterial({ color: 0x111a20 }),
    );
    screen.position.set(0, -0.035, 0.08);
    group.add(screen);
    for (let row = 0; row < 5; row++) {
      const line = new T.Mesh(
        lineGeometry,
        new T.MeshBasicMaterial({ color: row === 0 ? 0x91d5e5 : 0x52636d }),
      );
      line.scale.x = [1.2, 0.82, 1.48, 0.99, 0.65][(row + i) % 5];
      line.position.set(-0.18, 0.35 - row * 0.155, 0.095);
      group.add(line);
    }
    const led = new T.Mesh(new T.SphereGeometry(0.023, 8, 6), accent);
    led.position.set(-0.91, 0.6, 0.08);
    group.add(led);
    return group;
  });
  const vault = new T.Group();
  vault.name = "local-vault";
  studio.add(vault);
  vault.add(new T.Mesh(new RoundedBoxGeometry(1.85, 1.9, 0.72, 4, 0.15), graphite));
  const door = new T.Mesh(
    new RoundedBoxGeometry(1.55, 1.61, 0.08, 3, 0.11),
    new T.MeshStandardMaterial({ color: 0x36454f, metalness: 0.65, roughness: 0.4 }),
  );
  door.position.z = 0.39;
  vault.add(door);
  const dial = new T.Mesh(new T.TorusGeometry(0.27, 0.035, 8, 40), accent);
  dial.position.set(0, 0, 0.48);
  vault.add(dial);
  const spoke = new T.Mesh(new RoundedBoxGeometry(0.065, 0.29, 0.06, 2, 0.02), pearl);
  spoke.position.z = 0.5;
  vault.add(spoke);
  const orbit = new T.Mesh(
    new T.TorusGeometry(1.5, 0.008, 4, 100),
    new T.MeshBasicMaterial({ color: 0x4d7581, transparent: true, opacity: 0.45 }),
  );
  orbit.rotation.x = 1.17;
  orbit.position.y = -0.8;
  studio.add(orbit);
  // cameraZ, mascotX/Y/Z, scale, windows, vault, orbit
  const poses = [
    [10, 3, -2, -3, 0.4, 0, 0, 0],
    [8, 1.8, 0.05, 0, 1.25, 0, 0, 0.25],
    [10, 2.05, -0.25, 0.5, 0.92, 1, 0, 1],
    [9, 2.1, 0.6, 0.35, 0.8, 0, 1, 0.6],
    [8.5, 1.8, 0, 0.2, 1.12, 0, 0, 0.35],
  ];
  let width = 0,
    height = 0,
    last = performance.now(),
    smooth = readState().progress,
    disposed = false,
    lost = false;
  let greetAt = -10000,
    pointer = { x: 0, y: 0 },
    feature = 0,
    frames = [],
    elapsed = [];
  const lerp = T.MathUtils.lerp,
    clamp = T.MathUtils.clamp;
  function resize() {
    width = innerWidth;
    height = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio, width < 901 ? 1.25 : 1.5));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  resize();
  const onPointer = (e) => {
    pointer.x = clamp((e.clientX / width - 0.5) * 2, -1, 1);
    pointer.y = clamp((e.clientY / height - 0.5) * 2, -1, 1);
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  const onLoss = (e) => {
    e.preventDefault();
    lost = true;
    renderer.setAnimationLoop(null);
    document.documentElement.classList.remove("has-world");
  };
  canvas.addEventListener("webglcontextlost", onLoss);
  const onRestore = () => {
    lost = false;
    last = performance.now();
    document.documentElement.classList.add("has-world");
    renderer.setAnimationLoop(frame);
  };
  canvas.addEventListener("webglcontextrestored", onRestore);
  function frame(now) {
    if (disposed || lost) return;
    const state = readState();
    if (document.hidden || state.paused || height < 511) return;
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 1 / 30);
    last = now;
    if (width !== innerWidth || height !== innerHeight) resize();
    smooth = lerp(smooth, state.progress, 1 - Math.exp(-10 * dt));
    const a = Math.floor(smooth),
      b = Math.min(4, a + 1),
      t = smooth - a;
    const p = poses[a].map((n, i) => lerp(n, poses[b][i], t));
    const mobile = width < 901;
    const greet = Math.max(0, 1 - (now - greetAt) / 1100);
    camera.position.set(0, 0, p[0]);
    camera.lookAt(0, 0, 0);
    const visible =
      clamp(smooth * 2, 0, 1) * (mobile && height < 721 ? clamp((3.75 - smooth) / 0.35, 0, 1) : 1);
    studio.visible = visible > 0.001;
    dot.position.set(mobile ? 0 : p[1], mobile ? (height < 721 ? 1.3 : 1.45) : p[2], p[3]);
    dot.scale.setScalar(p[4] * (mobile ? 0.67 : 1) * visible);
    dot.rotation.set(
      pointer.y * 0.06,
      pointer.x * 0.12,
      Math.sin((1 - greet) * Math.PI * 3) * greet * 0.12,
    );
    face.rotation.y = pointer.x * 0.06;
    const blink = now % 5300 > 5150 ? 0.16 : 1;
    for (const eye of eyes) eye.scale.y = blink;
    tasks.position.set(mobile ? 0 : 2.1, mobile ? 1.35 : 0, -0.2);
    tasks.scale.setScalar(Math.max(0.001, p[5] * (mobile ? 0.46 : 1)));
    tasks.visible = p[5] > 0.002;
    for (let i = 0; i < 3; i++) {
      windows[i].position.set((i - 1) * 0.75, (i - 1) * 0.73, -(i === feature ? 0 : i * 0.35));
      windows[i].rotation.set(0.02, (i - 1) * -0.25, -0.06 + (i - 1) * 0.03);
    }
    vault.position.set(mobile ? 0.55 : 2.45, mobile ? 1.2 : -0.5, -0.4);
    vault.rotation.set(0.03, -0.28, 0);
    vault.scale.setScalar(Math.max(0.001, p[6] * (mobile ? 0.55 : 1)));
    vault.visible = p[6] > 0.002;
    orbit.position.x = mobile ? 0 : p[1];
    orbit.position.y = mobile ? 0.92 : -0.86;
    orbit.scale.setScalar(mobile ? 0.5 : 1);
    orbit.material.opacity = p[7] * 0.35;
    const start = performance.now();
    renderer.render(scene, camera);
    elapsed.push(performance.now() - start);
    if (elapsed.length > 240) elapsed.shift();
    if (frameMs > 0 && frameMs < 1000) frames.push(frameMs);
    if (frames.length > 240) frames.shift();
  }
  camera.position.z = 8;
  await renderer.compileAsync(scene, camera);
  renderer.setAnimationLoop(frame);
  return {
    greet() {
      greetAt = performance.now();
    },
    feature(i) {
      feature = i;
    },
    resume() {
      last = performance.now();
      smooth = readState().progress;
    },
    metrics() {
      const sorted = [...frames].sort((a, b) => a - b);
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        textures: renderer.info.memory.textures,
        geometries: renderer.info.memory.geometries,
        frameMedian: sorted[Math.floor(sorted.length * 0.5)],
        frameP95: sorted[Math.floor(sorted.length * 0.95)],
        cpuRenderMean: elapsed.reduce((a, b) => a + b, 0) / elapsed.length,
        dpr: renderer.getPixelRatio(),
      };
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onLoss);
      canvas.removeEventListener("webglcontextrestored", onRestore);
      const geometries = new Set(),
        materials = new Set();
      scene.traverse((o) => {
        if (o.geometry) geometries.add(o.geometry);
        if (o.material) materials.add(o.material);
      });
      geometries.forEach((g) => {
        g.dispose();
      });
      materials.forEach((m) => {
        m.dispose();
      });
      shadowTexture.dispose();
      renderer.dispose();
    },
  };
}
