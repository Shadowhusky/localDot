import { readFileSync } from "node:fs";
import { join } from "node:path";

// The fixture's computer paints one still picture. Here it paints sample footage instead, a frame
// per film frame, through the same <video> the real stream arrives in, so the app's own stage shows it.
export const CLIENT = (first) => `
const keys=document.createElement('input');document.body.append(keys);keys.focus({preventScroll:true});
const canvas=document.createElement('canvas');canvas.width=2560;canvas.height=1600;
const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';
const video=document.getElementById('videoStream');
window.__filmPaint=async(src)=>{const b=await (await fetch(src)).blob();const i=await createImageBitmap(b);ctx.drawImage(i,0,0,2560,1600);i.close();};
window.__filmPaint(${JSON.stringify(first)}).then(()=>{video.srcObject=canvas.captureStream(60);video.play().catch(()=>{});});
`;

// Serves `dir`'s frames at /film-frames/<name>/<n>.jpg, and the client above for each screen named.
export async function routePicture(page, { dir, screens }) {
  for (const [script, first] of Object.entries(screens))
    await page.route(`**/${script}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: CLIENT(first) }),
    );
  await page.route("**/film-frames/**", (route) => {
    const name = new URL(route.request().url()).pathname.replace("/film-frames/", "");
    route.fulfill({ contentType: "image/jpeg", body: readFileSync(join(dir, name)) });
  });
}

// The frames that hold the screens' clients.
export const screenFrames = (page) =>
  page.frames().filter((f) => /\/(desktop|browser)\/[^/]+\/$/.test(new URL(f.url()).pathname));
export const frameOf = (page, screen) =>
  page.frames().find((f) => new URL(f.url()).pathname.includes(`/${screen}/`));

// Paints a run of 30 fps frames on `screen` as the take goes.
export function paintEach(page, screen, name, { from, count, start = 0 }) {
  let last = -1;
  return async (t) => {
    const index = Math.floor((t - from) * 30);
    if (index === last) return;
    last = index;
    const n = ((start + Math.max(0, index)) % count) + 1;
    await frameOf(page, screen)
      ?.evaluate(
        (src) => window.__filmPaint?.(src),
        `/film-frames/${name}/${String(n).padStart(4, "0")}.jpg`,
      )
      .catch(() => {});
  };
}

// One run of the game across the whole film, wherever it shows, so its score only ever goes up: its
// clock is the film's, two seconds behind.
export const gameTime = (t) => Math.max(0, t - 2);
// The computer's game is in daylight while the phone watches it and at night by the time Studio shows it.
export const deskLook = (seconds) => (seconds < 9 ? "day" : "night");
export const WINDOW_FRAMES = 24 * 30;
export const gameFrame = (t) => Math.min(WINDOW_FRAMES - 1, Math.round(gameTime(t) * 30));

export function paintGame(page) {
  let last = -1;
  return async (t) => {
    const index = gameFrame(t);
    if (index === last) return;
    last = index;
    await frameOf(page, "desktop")
      ?.evaluate(
        (src) => window.__filmPaint?.(src),
        `/film-frames/dotrun/${String(index + 1).padStart(4, "0")}.jpg`,
      )
      .catch(() => {});
  };
}
