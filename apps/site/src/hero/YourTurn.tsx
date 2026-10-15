import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { site } from "../state.ts";
import {
  BRICK_H,
  BRICK_W,
  brickAt,
  type Game,
  launch,
  newGame,
  PADDLE_TOP,
  PADDLE_W,
  PANEL,
  PLAY,
  R,
  step,
} from "./breakout.ts";

// While the visitor has control, dot's screen answers them. On Breakout it is the game itself, in
// the page dot built, where the recording shows it: the visitor picks up dot's game as it stands,
// its bricks, score and lives, and a finished game racks a new wall in the same panel. On the other
// demos their pointer shows on dot's screen and their clicks land there.
export function YourTurn({
  video,
  breakout,
  travelling,
  leaving,
}: {
  video: HTMLVideoElement | null;
  breakout: boolean;
  // The replay is still on its way to dot's game.
  travelling: boolean;
  // Handed back: the screen goes back to the recording under it.
  leaving: boolean;
}) {
  return (
    <div className="your-turn" data-leaving={leaving || undefined}>
      {breakout ? <Breakout video={video} travelling={travelling} /> : <YourPointer />}
    </div>
  );
}

// The recording's pixels; the game draws over its panel.
const W = 1920;
const H = 1200;
const BOX = {
  x: PANEL.left,
  y: PANEL.top,
  w: PANEL.right - PANEL.left,
  h: PANEL.bottom - PANEL.top,
};
// Where dot's page shows the score and the lives.
const SCORE = { x: 306, y: 304 };
const LIFE = { x: 1532, step: 39, y: 279, r: 12.5 };
const COUNT = { x: 1613, y: PADDLE_TOP + 50 };

interface Frame {
  // The whole frame the game was read from, held around it: a paused video's picture can lag a seek.
  still: HTMLCanvasElement;
  // The panel as recorded, its paddle, ball and numbers taken out.
  base: ImageData;
  // The same without its bricks, for a broken one's place and a new wall.
  behind: ImageData;
  game: Game;
}

const luma = (d: Uint8ClampedArray, i: number) =>
  0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);

// The paused frame's panel, if it shows the game in play.
function readGame(video: HTMLVideoElement): Frame | null {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = BOX.w;
  canvas.height = BOX.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const scale = video.videoWidth / W;
  ctx.drawImage(
    video,
    BOX.x * scale,
    BOX.y * scale,
    BOX.w * scale,
    BOX.h * scale,
    0,
    0,
    BOX.w,
    BOX.h,
  );
  const base = ctx.getImageData(0, 0, BOX.w, BOX.h);
  const d = base.data;
  const at = (x: number, y: number) =>
    ((Math.round(y) - BOX.y) * BOX.w + (Math.round(x) - BOX.x)) * 4;
  const navy = (x: number, y: number) => {
    const i = at(x, y);
    return (d[i + 2] ?? 0) > (d[i] ?? 0) + 10 && luma(d, i) < 80;
  };
  if ([300, 700, 1200, 1620].filter((x) => navy(x, 900)).length < 3) return null;
  const bricks = Array.from({ length: 50 }, (_, n) => {
    const [x, y] = brickAt(n);
    const i = at(x + BRICK_W / 2, y + BRICK_H / 2);
    return (
      Math.max(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0) -
        Math.min(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0) >
      60
    );
  });
  if (!bricks.some(Boolean)) return null;
  // The paddle: the bright run along its row.
  const run: number[] = [];
  for (let x = PLAY.left; x < PLAY.right; x++)
    if (luma(d, at(x, PADDLE_TOP + 9)) > 190) run.push(x);
  if (run.length < PADDLE_W / 2) return null;
  const paddleFrom = run[0] ?? 0;
  const paddleTo = run.at(-1) ?? 0;
  // The ball: the bright white above the paddle, among the bricks too; bricks are coloured, the ball
  // is near white. It is never inside a brick still standing, where compression can bleach a brick's
  // highlight nearly white.
  const onBrick = (x: number, y: number) =>
    bricks.some((standing, n) => {
      if (!standing) return false;
      const [bx, by] = brickAt(n);
      return x > bx - 3 && x < bx + BRICK_W + 3 && y > by - 3 && y < by + BRICK_H + 3;
    });
  const white = (i: number) =>
    luma(d, i) > 170 &&
    Math.max(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0) -
      Math.min(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0) <
      45;
  let ball: { x0: number; x1: number; y0: number; y1: number } | null = null;
  for (let y = PLAY.top + 2; y < PADDLE_TOP - 6; y += 2)
    for (let x = PLAY.left + 4; x < PLAY.right - 4; x += 2)
      if (white(at(x, y)) && !onBrick(x, y)) {
        ball ??= { x0: x, x1: x, y0: y, y1: y };
        ball.x0 = Math.min(ball.x0, x);
        ball.x1 = Math.max(ball.x1, x);
        ball.y0 = Math.min(ball.y0, y);
        ball.y1 = Math.max(ball.y1, y);
      }
  if (ball && (ball.x1 - ball.x0 > 60 || ball.y1 - ball.y0 > 60)) ball = null;
  const lives = [0, 1, 2].filter((i) => luma(d, at(LIFE.x + i * LIFE.step, LIFE.y)) > 150).length;
  // Paints a box with the panel as it would be there: blended from the colours just outside its
  // four corners.
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    const left = Math.max(BOX.x, Math.round(x0));
    const right = Math.min(BOX.x + BOX.w - 1, Math.round(x1));
    const top = Math.max(BOX.y, Math.round(y0));
    const bottom = Math.min(BOX.y + BOX.h - 1, Math.round(y1));
    const corner = (x: number, y: number) =>
      at(
        Math.min(BOX.x + BOX.w - 1, Math.max(BOX.x, x)),
        Math.min(BOX.y + BOX.h - 1, Math.max(BOX.y, y)),
      );
    const [a, b, c, e] = [
      corner(left - 3, top - 3),
      corner(right + 3, top - 3),
      corner(left - 3, bottom + 3),
      corner(right + 3, bottom + 3),
    ];
    const ink = [a, b, c, e].map((i) => [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0]);
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const u = (x - left) / Math.max(1, right - left);
        const v = (y - top) / Math.max(1, bottom - top);
        const i = at(x, y);
        for (let k = 0; k < 3; k++)
          d[i + k] =
            ((ink[0]?.[k] ?? 0) * (1 - u) + (ink[1]?.[k] ?? 0) * u) * (1 - v) +
            ((ink[2]?.[k] ?? 0) * (1 - u) + (ink[3]?.[k] ?? 0) * u) * v;
      }
  };
  // The recorded paddle, ball, score, lives and count go, glow and all: the game keeps them now.
  fill(paddleFrom - 28, PADDLE_TOP - 18, paddleTo + 28, PADDLE_TOP + 36);
  if (ball) fill(ball.x0 - 16, ball.y0 - 16, ball.x1 + 16, ball.y1 + 16);
  fill(1440, PADDLE_TOP + 27, 1640, PADDLE_TOP + 62);
  fill(298, 266, 470, 314);
  fill(1514, 262, 1628, 297);
  // The panel behind the bricks: each column graded from just above them to just below.
  const behind = new ImageData(new Uint8ClampedArray(d), BOX.w, BOX.h);
  const band = { top: 320, bottom: 584 };
  for (let x = PANEL.left + 1; x < PANEL.right - 1; x++) {
    const a = at(x, band.top - 2);
    const b = at(x, band.bottom + 2);
    for (let y = band.top; y <= band.bottom; y++) {
      const k = (y - band.top) / (band.bottom - band.top);
      const i = at(x, y);
      for (let c = 0; c < 3; c++)
        behind.data[i + c] = (d[a + c] ?? 0) * (1 - k) + (d[b + c] ?? 0) * k;
    }
  }
  const game = newGame(bricks, (paddleFrom + paddleTo) / 2, Math.max(1, lives));
  // A ball in flight carries on from where it was; one not found waits on the paddle.
  if (ball) {
    launch(game);
    game.ball.x = (ball.x0 + ball.x1) / 2;
    game.ball.y = (ball.y0 + ball.y1) / 2;
  }
  const still = document.createElement("canvas");
  still.width = video.videoWidth;
  still.height = video.videoHeight;
  still.getContext("2d")?.drawImage(video, 0, 0);
  return { still, base, behind, game };
}

// Waits for the frame the recording comes to rest on, landed and still, then plays it.
function Breakout({ video, travelling }: { video: HTMLVideoElement | null; travelling: boolean }) {
  const [frame, setFrame] = useState<Frame | null | undefined>(undefined);
  const read = useRef(false);
  useEffect(() => {
    if (read.current || travelling) return;
    if (!video) {
      read.current = true;
      setFrame(null);
      return;
    }
    let raf = 0;
    const rest = () => {
      if (!video.paused || video.seeking) {
        raf = requestAnimationFrame(rest);
        return;
      }
      read.current = true;
      setFrame(readGame(video));
    };
    rest();
    return () => cancelAnimationFrame(raf);
  }, [video, travelling]);
  return frame === undefined ? null : <Play frame={frame} />;
}

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
// Each row's brick: its face, lit from above.
const ROWS = [
  ["#e66681", "#d7516b", "#b5435b"],
  ["#e8a05c", "#d98d45", "#b97636"],
  ["#e6cf7e", "#d8c068", "#b8a256"],
  ["#66cfa3", "#51bf91", "#43a37a"],
  ["#73b0e6", "#5b9cda", "#4b84ba"],
] as const;

// The game in dot's panel. The pointer anywhere on dot's screen moves the paddle, as on the page
// dot built; so do the arrow keys, with Space to launch, P to pause and R to start again.
function Play({ frame }: { frame: Frame | null }) {
  const game = useRef<Game>(frame?.game ?? newGame(Array(50).fill(true), 960));
  // A new wall stands on the panel without dot's bricks, drawn whole.
  const fresh = useRef(!frame);
  const target = useRef(game.current.paddle);
  const canvas = useRef<HTMLCanvasElement>(null);
  const held = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!frame || !held.current) return;
    held.current.width = frame.still.width;
    held.current.height = frame.still.height;
    held.current.getContext("2d")?.drawImage(frame.still, 0, 0);
  }, [frame]);
  useEffect(() => canvas.current?.focus({ preventScroll: true }), []);
  const pressed = useRef<[number, number] | null>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const layer = () => {
      const c = document.createElement("canvas");
      c.width = BOX.w;
      c.height = BOX.h;
      return c;
    };
    const recorded = layer();
    const bare = layer();
    const recordedCtx = recorded.getContext("2d");
    const bareCtx = bare.getContext("2d");
    if (!recordedCtx || !bareCtx) return;
    if (frame) {
      recordedCtx.putImageData(frame.base, 0, 0);
      bareCtx.putImageData(frame.behind, 0, 0);
    } else panel(bareCtx);
    const touch = matchMedia("(pointer: coarse)").matches;
    let last = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // Out of sight, the game waits where it is.
      if (site.offstage) {
        last = now;
        return;
      }
      const g = game.current;
      step(g, Math.min(0.05, (now - last) / 1000), target.current);
      last = now;
      for (const n of g.broken) {
        const [x, y] = brickAt(n);
        const [sx, sy] = [x - BOX.x - 4, y - BOX.y - 4];
        recordedCtx.clearRect(sx, sy, BRICK_W + 8, BRICK_H + 8);
        recordedCtx.drawImage(
          bare,
          sx,
          sy,
          BRICK_W + 8,
          BRICK_H + 8,
          sx,
          sy,
          BRICK_W + 8,
          BRICK_H + 8,
        );
      }
      ctx.drawImage(fresh.current ? bare : recorded, 0, 0);
      ctx.save();
      ctx.translate(-BOX.x, -BOX.y);
      if (fresh.current)
        for (const [n, standing] of g.bricks.entries()) if (standing) brick(ctx, n);
      ctx.fillStyle = "#f2f4f8";
      ctx.font = `700 44px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText(String(g.score), SCORE.x, SCORE.y);
      for (let i = 0; i < 3; i++) life(ctx, LIFE.x + i * LIFE.step, LIFE.y, i < g.lives);
      paddle(ctx, g.paddle, PADDLE_TOP);
      ball(ctx, g.ball.x, g.ball.y, g.ball.vx, g.ball.vy);
      ctx.fillStyle = "rgb(150 158 190 / 0.75)";
      ctx.font = `500 20px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(`${g.bricks.filter(Boolean).length} bricks left`, COUNT.x, COUNT.y);
      const press = touch ? "Tap" : "Click";
      const status =
        g.over === "won"
          ? `You win! ${press} to play again`
          : g.over === "lost"
            ? `Game over. ${press} to play again`
            : g.paused
              ? touch
                ? "Paused. Tap to carry on"
                : "Paused. Press P to carry on"
              : g.held
                ? `${press} to launch`
                : "";
      if (status) {
        ctx.fillStyle = "rgb(214 220 240 / 0.85)";
        ctx.font = `600 30px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillText(status, 960, 800);
      }
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frame]);
  // The pointer on dot's screen, in the recording's pixels; the arrow hides over the game's panel,
  // where the paddle answers it.
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const x = (event.nativeEvent.offsetX / el.clientWidth) * W;
    const y = (event.nativeEvent.offsetY / el.clientHeight) * H;
    target.current = x;
    el.style.cursor =
      x > PANEL.left && x < PANEL.right && y > PANEL.top && y < PANEL.bottom ? "none" : "";
  };
  const again = () => {
    game.current = newGame(Array(50).fill(true), game.current.paddle);
    fresh.current = true;
  };
  // A click launches, or carries on a paused game; after the end, it racks a new wall.
  const start = () => {
    const g = game.current;
    if (g.over) again();
    else if (g.paused) g.paused = false;
    else launch(g);
  };
  const keys = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const g = game.current;
    const key = event.key.toLowerCase();
    if (key === "arrowleft") target.current = g.paddle - 80;
    else if (key === "arrowright") target.current = g.paddle + 80;
    else if (key === " ") start();
    else if (key === "p") g.paused = !g.paused && !g.held && !g.over;
    else if (key === "r") again();
    else return;
    event.preventDefault();
  };
  return (
    <>
      {frame && <canvas ref={held} className="your-still" />}
      <div
        className="your-play"
        onPointerMove={follow}
        // A tap acts and a swipe only scrolls the page; either way the keys stay with the game.
        onPointerDown={(event) => {
          follow(event);
          pressed.current = [event.clientX, event.clientY];
        }}
        onPointerUp={(event) => {
          const at = pressed.current;
          pressed.current = null;
          canvas.current?.focus({ preventScroll: true });
          if (at && Math.hypot(event.clientX - at[0], event.clientY - at[1]) < 12) start();
        }}
        onPointerCancel={() => {
          pressed.current = null;
        }}
      >
        <canvas
          ref={canvas}
          className="your-game"
          width={BOX.w}
          height={BOX.h}
          style={{
            left: `${(BOX.x / W) * 100}%`,
            top: `${(BOX.y / H) * 100}%`,
            width: `${(BOX.w / W) * 100}%`,
            height: `${(BOX.h / H) * 100}%`,
          }}
          tabIndex={0}
          aria-label={t(
            "Breakout, yours to play: move the paddle with the pointer or the arrow keys, and launch with Space.",
          )}
          onKeyDown={keys}
        />
      </div>
    </>
  );
}

// dot's panel, drawn in its style, for a frame that does not show the game.
function panel(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(-BOX.x, -BOX.y);
  ctx.beginPath();
  ctx.roundRect(PANEL.left, PANEL.top, BOX.w, BOX.h, 24);
  const fill = ctx.createLinearGradient(0, PANEL.top, 0, PANEL.bottom);
  fill.addColorStop(0, "#1d2647");
  fill.addColorStop(1, "#1a1f3e");
  ctx.fillStyle = fill;
  ctx.fill();
  const glow = ctx.createRadialGradient(960, PANEL.top, 40, 960, PANEL.top, 900);
  glow.addColorStop(0, "rgb(70 90 140 / 0.35)");
  glow.addColorStop(1, "rgb(70 90 140 / 0)");
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.strokeStyle = "rgb(255 255 255 / 0.07)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#8b93b1";
  ctx.font = `600 22px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("SCORE", SCORE.x, 262);
  ctx.textAlign = "right";
  ctx.fillText("LIVES", COUNT.x, 262);
  ctx.restore();
}

function brick(ctx: CanvasRenderingContext2D, n: number): void {
  const [x, y] = brickAt(n);
  const [top, mid, bottom] = ROWS[Math.floor(n / 10)] ?? ROWS[0];
  const face = ctx.createLinearGradient(0, y, 0, y + BRICK_H);
  face.addColorStop(0, top);
  face.addColorStop(0.45, mid);
  face.addColorStop(1, bottom);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.roundRect(x, y, BRICK_W, BRICK_H, 7);
  ctx.fill();
  ctx.fillStyle = "rgb(255 255 255 / 0.35)";
  ctx.fillRect(x + 10, y + 4, BRICK_W - 20, 2);
}

// A life left is a little pearl, like the ball; a life lost, its ghost.
function life(ctx: CanvasRenderingContext2D, x: number, y: number, left: boolean): void {
  ctx.beginPath();
  ctx.arc(x, y, LIFE.r, 0, Math.PI * 2);
  if (left) {
    const pearl = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, LIFE.r);
    pearl.addColorStop(0, "#ffffff");
    pearl.addColorStop(1, "#c9ced8");
    ctx.fillStyle = pearl;
  } else ctx.fillStyle = "rgb(232 236 245 / 0.18)";
  ctx.fill();
}

function paddle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const fill = ctx.createLinearGradient(0, y, 0, y + 19);
  fill.addColorStop(0, "#f4fdff");
  fill.addColorStop(0.5, "#dce7fe");
  fill.addColorStop(1, "#a7b4d4");
  ctx.save();
  ctx.shadowColor = "rgb(170 196 255 / 0.55)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x - PADDLE_W / 2, y, PADDLE_W, 19, 9.5);
  ctx.fill();
  ctx.restore();
}

// The ball is dot, looking where it is going.
function ball(ctx: CanvasRenderingContext2D, x: number, y: number, vx: number, vy: number): void {
  const fill = ctx.createRadialGradient(x - 4, y - 5, 2, x, y, R);
  fill.addColorStop(0, "#ffffff");
  fill.addColorStop(1, "#c9ced8");
  ctx.save();
  ctx.shadowColor = "rgb(220 230 255 / 0.6)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const speed = Math.hypot(vx, vy) || 1;
  const gx = (vx / speed) * 3;
  const gy = (vy / speed) * 2.5;
  ctx.fillStyle = "#0b0d12";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * 4.2 + gx, y - 1.5 + gy, 2, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// The visitor's own pointer on dot's screen, with a ring where they click.
function YourPointer() {
  const [at, setAt] = useState<[number, number] | null>(null);
  const [rings, setRings] = useState<{ id: number; x: number; y: number }[]>([]);
  const next = useRef(0);
  return (
    <div
      className="your-pointer"
      onPointerMove={(event) => setAt([event.nativeEvent.offsetX, event.nativeEvent.offsetY])}
      onPointerLeave={() => setAt(null)}
      onPointerDown={(event) => {
        const ring = {
          id: next.current++,
          x: event.nativeEvent.offsetX,
          y: event.nativeEvent.offsetY,
        };
        setRings((all) => [...all.slice(-4), ring]);
      }}
    >
      {rings.map((ring) => (
        <span
          key={ring.id}
          className="your-ring"
          style={{ left: ring.x, top: ring.y }}
          onAnimationEnd={() => setRings((all) => all.filter((r) => r.id !== ring.id))}
        />
      ))}
      {at && (
        <svg
          className="your-cursor"
          style={{ left: at[0], top: at[1] }}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M5 2.5v17.2l4.6-4.4 2.9 6.7 3-1.3-2.9-6.6h6.4z" />
        </svg>
      )}
    </div>
  );
}
