import { DotView } from "../../web/src/dot/render/DotView.ts";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const root = document.documentElement,
  sections = $$(".chapter"),
  panels = $$(".scene-panel");
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let paused = reduce.matches,
  progress = 0,
  world,
  worldPromise,
  active = -1,
  frame = 0;
let userPaused = false,
  hiddenPause = false;
const phone = matchMedia("(max-width:900px)").matches;
const mediaPath = (id, poster = false) =>
  `/demos/${id}${phone ? "-mobile" : ""}${poster ? "-poster.webp" : ".mp4"}?v=real-runs1`;
const video = $("#demo-video"),
  loader = $("#loader"),
  motion = $("#motion-toggle");
const demos = {
  work: {
    name: "Build a spreadsheet.",
    src: "/demos/work.mp4",
    copy: "Watch dot enter sales figures, calculate a total, and create a chart in LibreOffice. A real task with invented data; edited at 2× speed.",
  },
  research: {
    name: "Compare two ideas.",
    src: "/demos/research.mp4",
    copy: "Follow dot browsing public sources to compare solar and wind power. Real task footage, edited at 2× speed.",
  },
  play: {
    name: "Draw a smile.",
    src: "/demos/play.mp4",
    copy: "See a drawing take shape as dot uses the computer. Real task footage, edited at 2× speed.",
  },
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function measureProgress() {
  const y = scrollY;
  let i = 0;
  while (i < sections.length - 1 && y >= sections[i + 1].offsetTop) i++;
  return clamp(
    i +
      (y - sections[i].offsetTop) /
        (sections[i + 1]?.offsetTop - sections[i].offsetTop || innerHeight),
    0,
    4,
  );
}
function sync() {
  frame = 0;
  progress = measureProgress();
  const index = Math.round(progress),
    flat = innerHeight <= 510;
  panels.forEach((p, i) => {
    const d = progress - i,
      dist = Math.abs(d),
      show = i === index || flat;
    const opacity = 1 - clamp((dist - 0.12) / 0.8, 0, 1);
    p.style.opacity = String(opacity);
    p.style.transform = paused
      ? "none"
      : `perspective(1400px) translate3d(0,${-d * 28}px,${-dist * 110}px) rotateX(${d * 1.8}deg)`;
    p.dataset.active = String(show);
    p.inert = !show;
    p.setAttribute("aria-hidden", String(!show));
  });
  if (active !== index) {
    active = index;
    $$(".journey-footer nav a").forEach((link, i) => {
      if (i === index) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    if (index !== 0 && !flat) video.pause();
    else if (!userPaused && !paused && !document.hidden) tryPlay();
  }
  root.style.setProperty("--chapter", String(progress));
}
function schedule() {
  if (!frame) frame = requestAnimationFrame(sync);
}
function updateMotion() {
  root.classList.toggle("calm", paused);
  motion.textContent = paused ? "Enable motion" : "Pause motion";
  motion.setAttribute("aria-pressed", String(paused));
  if (paused) {
    video.pause();
    root.classList.remove("has-world");
  } else {
    ensureWorld();
    if (active === 0 && !userPaused) tryPlay();
    if (world) root.classList.add("has-world");
  }
  world?.resume();
  schedule();
}
async function ensureWorld() {
  if (paused || worldPromise) return;
  worldPromise = import("./world.js")
    .then((m) => m.createWorld($("#world-canvas"), () => ({ progress, paused })))
    .then((w) => {
      world = w;
      if (!paused) root.classList.add("has-world");
    })
    .catch(() => {
      root.classList.remove("has-world");
    });
}
function message(text) {
  $("#video-message").textContent = text;
  $("#video-message").hidden = !text;
}
async function tryPlay() {
  if (document.hidden) return;
  try {
    await video.play();
    message("");
  } catch (e) {
    if (e.name !== "AbortError") message("Press play to watch the replay.");
  }
}
const time = (n) =>
  `${Math.floor((n || 0) / 60)}:${String(Math.floor((n || 0) % 60)).padStart(2, "0")}`;
function playerState() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  $("#replay-time").textContent = `${time(video.currentTime)} / ${time(duration)}`;
  $("#replay-seek").value = duration ? (video.currentTime / duration) * 100 : 0;
  $("#play-toggle").setAttribute("aria-label", video.paused ? "Play replay" : "Pause replay");
  $("#play-path").setAttribute(
    "d",
    video.paused ? "m8 5 11 7-11 7Z" : "M6 5h4v14H6zM14 5h4v14h-4z",
  );
}
async function selectDemo(id) {
  const demo = demos[id];
  if (!demo) return;
  userPaused = false;
  video.pause();
  $$("[data-demo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.demo === id)));
  $("#replay-name").textContent = demo.name;
  $("#replay-description").textContent = demo.copy;
  message("Loading replay…");
  video.poster = mediaPath(id, true);
  video.src = mediaPath(id);
  video.load();
  playerState();
}
$$("[data-demo]").forEach((b) => b.addEventListener("click", () => selectDemo(b.dataset.demo)));
$("#play-toggle").addEventListener("click", () => {
  userPaused = !video.paused;
  if (video.paused) tryPlay();
  else video.pause();
});
$("#replay-seek").addEventListener("input", (e) => {
  if (Number.isFinite(video.duration))
    video.currentTime = (video.duration * Number(e.target.value)) / 100;
});
for (const event of ["timeupdate", "durationchange", "play", "pause"])
  video.addEventListener(event, playerState);
video.addEventListener("canplay", () => {
  message("");
  dismissLoader();
  if (active === 0 && !paused && !userPaused) tryPlay();
});
video.addEventListener("error", () => {
  dismissLoader();
  message("This replay could not load. Choose another demo or try again.");
});
video.addEventListener("waiting", () => message("Loading replay…"));
video.controls = false;
$(".replay-controls").hidden = false;
if (phone) {
  video.poster = mediaPath("work", true);
  video.src = mediaPath("work");
  video.load();
}
let placeholder = null;
function restorePlayer() {
  const player = $(".replay-main");
  if (placeholder) {
    placeholder.replaceWith(player);
    placeholder = null;
  }
  player.classList.remove("expanded-player");
  $("#fullscreen").setAttribute("aria-label", "Expand replay");
}
$("#fullscreen").addEventListener("click", async () => {
  const player = $(".replay-main");
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (placeholder) {
    restorePlayer();
    return;
  }
  if (player.requestFullscreen) {
    try {
      await player.requestFullscreen();
      $("#fullscreen").setAttribute("aria-label", "Exit expanded replay");
      return;
    } catch {}
  }
  placeholder = document.createElement("div");
  placeholder.style.height = player.offsetHeight + "px";
  player.replaceWith(placeholder);
  document.body.append(player);
  player.classList.add("expanded-player");
  $("#fullscreen").setAttribute("aria-label", "Exit expanded replay");
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) $("#fullscreen").setAttribute("aria-label", "Expand replay");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") restorePlayer();
});
let loaderDot;
function dismissLoader() {
  loader.hidden = true;
  loaderDot?.destroy();
  loaderDot = undefined;
}
if (!location.hash && !paused) {
  loader.hidden = false;
  loaderDot = new DotView($("#loading-dot"), {
    size: 128,
    state: "waking",
    control: false,
    reducedMotion: false,
    seed: 42,
  });
  setTimeout(() => {
    if (!loader.hidden) {
      dismissLoader();
      message("The replay is still loading. You can explore the page meanwhile.");
    }
  }, 5000);
}
$("#skip-loading").addEventListener("click", dismissLoader);
const poster = new Image();
poster.src = video.poster;
poster.decode().then(dismissLoader).catch(dismissLoader);
const greetings = [
  "Hello, you. What shall we do first?",
  "Something useful? Something fun? I’m here.",
  "A little curiosity goes a long way.",
];
let greeting = 0;
$("#greet").addEventListener("click", () => {
  $("#greeting").textContent = greetings[greeting++ % greetings.length];
  world?.greet();
});
const features = {
  work: [
    "A real computer. Real work.",
    "Browse, research with sources, run code, and make files you can open right in the conversation. Connect your apps or let dot use the screen.",
    "Read. Think. Make.",
    "Every step, in view.",
  ],
  memory: [
    "A little wiser next time.",
    "Useful lessons can carry across sessions: your preferences, working approaches, and things worth remembering. Review and edit what dot knows.",
    "Remember what helps.",
    "You decide what stays.",
  ],
  routines: [
    "For the things you do again.",
    "Set up a routine for recurring work. dot can follow the steps, use your connected apps, and ask when a decision needs you.",
    "On your schedule.",
    "Still under your control.",
  ],
};
$$("[data-feature]").forEach((b, i) =>
  b.addEventListener("click", () => {
    const [title, copy, a, c] = features[b.dataset.feature];
    $("#feature-title").textContent = title;
    $("#feature-copy").textContent = copy;
    $("#window-label-one").textContent = a;
    $("#window-label-two").textContent = c;
    $$("[data-feature]").forEach((v) => v.setAttribute("aria-pressed", String(v === b)));
    world?.feature(i);
  }),
);
$("#feature-demo").addEventListener("click", () => selectDemo("work"));
const permissions = {
  ask: "Review actions when your permission is needed. dot keeps the request next to the task.",
  auto: "Automatic review handles routine approvals. You stay involved when a decision needs you.",
  full: "Let routine work proceed. Destructive actions still require your confirmation.",
};
$$("[data-permission]").forEach((b) =>
  b.addEventListener("click", () => {
    $$("[data-permission]").forEach((v) => v.setAttribute("aria-pressed", String(v === b)));
    $("#permission-copy").textContent = permissions[b.dataset.permission];
  }),
);
motion.hidden = false;
motion.addEventListener("click", () => {
  paused = !paused;
  updateMotion();
});
reduce.addEventListener("change", () => {
  paused = reduce.matches;
  updateMotion();
});
window.addEventListener("scroll", schedule, { passive: true });
window.addEventListener("resize", schedule, { passive: true });
window.addEventListener("hashchange", schedule);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenPause = !video.paused;
    video.pause();
  } else {
    world?.resume();
    if (hiddenPause && active === 0 && !userPaused && !paused) tryPlay();
    schedule();
  }
});
window.addEventListener("pagehide", (e) => {
  video.pause();
  if (!e.persisted) {
    world?.dispose();
    loaderDot?.destroy();
    cancelAnimationFrame(frame);
  }
});
window.addEventListener("pageshow", () => {
  world?.resume();
  schedule();
  if (active === 0 && !userPaused && !paused) tryPlay();
});
root.classList.add("enhanced");
sync();
updateMotion();
if (import.meta.env.DEV)
  window.siteMetrics = () => ({ progress, active, paused, ...world?.metrics() });

const installers = {
  mac: [
    "curl -fsSL https://downloads.localdot.dev/install.sh | bash",
    "Apple silicon Mac. Paste this in Terminal.",
  ],
  windows: [
    "irm https://downloads.localdot.dev/install.ps1 | iex",
    "Windows with WSL 2. Paste this in PowerShell.",
  ],
  linux: [
    "curl -fsSL https://downloads.localdot.dev/install.sh | bash",
    "Linux x64 with systemd. Paste this in your terminal.",
  ],
};
$$("[data-os]").forEach((b) =>
  b.addEventListener("click", () => {
    const [command, help] = installers[b.dataset.os];
    $("#install-command").textContent = command;
    $("#install-help").textContent = help;
    $("#install-feedback").textContent = "Setup guides you through Docker if it is missing.";
    $$("[data-os]").forEach((v) => v.setAttribute("aria-pressed", String(v === b)));
  }),
);
$("#copy-install").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#install-command").textContent);
    $("#install-feedback").textContent = "Copied. Paste it into your terminal to begin.";
  } catch {
    $("#install-feedback").textContent = "Select and copy the command above.";
  }
});
