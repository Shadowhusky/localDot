import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// One continuous take of the running app, frame by frame: the page's clock stands still and moves
// only by a frame at a time, so its own timers, transitions and animations play at their true speed
// however long each picture takes, and anything can land exactly on the film's beat.
export const CLOCK_INIT = () => {
  const raf = window.requestAnimationFrame.bind(window);
  const yieldFrame = () => new Promise((resolve) => raf(resolve));
  window.__filmStep = async (ms) => {
    for (const a of document.getAnimations()) {
      if (a.playState === "finished") continue;
      if (a.__at === undefined) {
        a.__at = a.currentTime ?? 0;
        a.pause();
      }
      a.__at += ms;
      const end = a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY;
      if (a.__at >= end) a.finish();
      else a.currentTime = a.__at;
    }
    await yieldFrame();
    await yieldFrame();
  };
  // A frame is taken once layout has settled: fonts in, two frames drawn, and nothing the film shows
  // being resized.
  let resized = 0;
  const watch = new ResizeObserver(() => {
    resized += 1;
  });
  const WATCHED = ".composer, .composer-card, .thread, .preview-card, .stage-frame, .phone-picture";
  window.__filmSettle = async () => {
    await document.fonts.ready;
    for (let i = 0; i < 8; i++) {
      for (const el of document.querySelectorAll(WATCHED)) watch.observe(el);
      const before = resized;
      await yieldFrame();
      await yieldFrame();
      if (resized === before) return true;
    }
    return false;
  };
  // What may never be in a frame: a field scrolled or overflowing, a field outside its card, or text
  // cut by a box that hides what overflows it, unless the box ellipsises it or scrolls it on purpose.
  const shown = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05)
        return false;
    }
    return true;
  };
  const inside = (a, b) =>
    a.left >= b.left - 1 &&
    a.right <= b.right + 1 &&
    a.top >= b.top - 1 &&
    a.bottom <= b.bottom + 1;
  window.__filmCheck = () => {
    const faults = [];
    for (const field of document.querySelectorAll("textarea, input:not([type=hidden])")) {
      if (!shown(field)) continue;
      if (field.scrollTop !== 0 || field.scrollHeight > field.clientHeight + 1)
        faults.push(
          `field scrolled or overflowing: ${field.scrollTop} ${field.scrollHeight}/${field.clientHeight}`,
        );
      const card = field.closest(".composer-card, .composer");
      if (card && !inside(field.getBoundingClientRect(), card.getBoundingClientRect()))
        faults.push("field outside its composer card");
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const host = node.parentElement;
      if (!node.textContent.trim() || !host || !shown(host)) continue;
      let clip = host;
      for (; clip && clip !== document.body; clip = clip.parentElement) {
        const style = getComputedStyle(clip);
        if (/hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)) break;
      }
      if (!clip || clip === document.body) continue;
      const style = getComputedStyle(clip);
      if (/auto|scroll/.test(style.overflowX + style.overflowY)) continue;
      if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") continue;
      const box = clip.getBoundingClientRect();
      // Words kept for screen readers only, in a box of a pixel.
      if (box.width <= 2 || box.height <= 2) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects())
        if (line.width > 0 && !inside(line, box)) {
          faults.push(
            `text cut by its box: "${node.textContent.trim().slice(0, 40)}" in .${clip.className}`,
          );
          break;
        }
    }
    return faults;
  };
};

export class Take {
  constructor(page, { out, scale = 1, fps = 60, from = 0, crf = 11, preset = "medium" }) {
    this.page = page;
    this.scale = scale;
    this.out = out;
    this.fps = fps;
    this.from = from;
    this.crf = crf;
    this.preset = preset;
    this.n = 0;
    this.marks = {};
    this.jobs = [];
  }

  // The film time of the frame to be taken next.
  get t() {
    return this.from + this.n / this.fps;
  }

  async begin(now) {
    mkdirSync(dirname(this.out), { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.page.clock.pauseAt(now);
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(this.fps),
        "-c:v",
        "png",
        "-i",
        "-",
        "-c:v",
        "libx264",
        // Gentle on a Mac that's in use: two threads.
        "-threads",
        "2",
        "-preset",
        this.preset,
        "-crf",
        String(this.crf),
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-movflags",
        "+faststart",
        this.out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    this.done = new Promise((resolve, reject) => {
      this.ffmpeg.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)),
      );
    });
  }

  async grab() {
    // The clip's scale is what brings the picture out at device pixels.
    const { width, height } = this.page.viewportSize();
    const { data } = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: true,
      clip: { ...(this.clip ?? { x: 0, y: 0, width, height }), scale: this.scale },
    });
    const png = Buffer.from(data, "base64");
    if (!this.ffmpeg.stdin.write(png))
      await new Promise((resolve) => this.ffmpeg.stdin.once("drain", resolve));
  }

  // What to do when the take reaches `at`, film seconds.
  at(at, act) {
    this.jobs.push({ at, act });
    this.jobs.sort((a, b) => a.at - b.at);
    return this;
  }

  async until(end) {
    while (this.t < end - 1e-6) {
      while (this.jobs[0] && this.jobs[0].at <= this.t + 1e-6) await this.jobs.shift().act();
      // What a job just set going runs on the film's clock too, from where it is now.
      await this.page.evaluate(() => window.__filmStep(0));
      if (!(await this.page.evaluate(() => window.__filmSettle())))
        throw new Error(`${this.out}: layout still moving at ${this.t.toFixed(3)} s`);
      const faults = await this.page.evaluate(() => window.__filmCheck());
      if (faults.length)
        throw new Error(`${this.out}: at ${this.t.toFixed(3)} s, ${faults.join("; ")}`);
      await this.grab();
      const ms =
        Math.round(((this.n + 1) * 1000) / this.fps) - Math.round((this.n * 1000) / this.fps);
      this.n += 1;
      await this.page.clock.runFor(ms);
      await this.page.evaluate((step) => window.__filmStep(step), ms);
      if (this.onFrame) await this.onFrame(this.t);
      if (this.n % 60 === 0) console.log(`${this.out.split("/").pop()} ${this.t.toFixed(2)}s`);
    }
  }

  async end() {
    this.ffmpeg.stdin.end();
    await this.done;
  }
}

// A finger: real touches through the browser, so it decides on presses and holds itself.
export function finger(cdp) {
  const send = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  return {
    down: (x, y) => send("touchStart", x, y),
    move: (x, y) => send("touchMove", x, y),
    up: () => send("touchEnd"),
  };
}
