// The Breakout dot built in its demo, as the visitor plays it on taking control. Everything is in
// the recording's own pixels (1920 × 1200), so the game lines up with the paused frame under it.

// The game's panel on the page, and where the ball may go: below the score, inside the panel.
export const PANEL = { left: 241, right: 1679, top: 211, bottom: 1111 };
export const PLAY = { left: 245, right: 1675, top: 316, bottom: 1111 };
// Ten bricks to a row and five rows, from the top left.
const BRICK_X = 312;
const BRICK_Y = 326;
const BRICK_STEP_X = 130.5;
const BRICK_STEP_Y = 51;
export const BRICK_W = 121;
export const BRICK_H = 41;
export const PADDLE_TOP = 1031;
export const PADDLE_W = 198;
export const R = 13;
const SPEED = 900;
const MAX_ANGLE = Math.PI / 3;

export interface Game {
  ball: { x: number; y: number; vx: number; vy: number };
  // The paddle's centre.
  paddle: number;
  bricks: boolean[];
  // Resting on the paddle until launched.
  held: boolean;
  // The bricks the last step broke.
  broken: number[];
  score: number;
  lives: number;
  over: "won" | "lost" | null;
  paused: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function brickAt(index: number): [number, number] {
  return [BRICK_X + (index % 10) * BRICK_STEP_X, BRICK_Y + Math.floor(index / 10) * BRICK_STEP_Y];
}

// A game with these bricks standing, scored as dot's game scores the ones gone: ten points for the
// bottom row, up to fifty for the top.
export function newGame(bricks: boolean[], paddle: number, lives = 3): Game {
  return {
    ball: { x: paddle, y: PADDLE_TOP - R, vx: 0, vy: 0 },
    paddle,
    bricks,
    held: true,
    broken: [],
    score: bricks.reduce(
      (sum, standing, n) => (standing ? sum : sum + 10 * (5 - Math.floor(n / 10))),
      0,
    ),
    lives,
    over: null,
    paused: false,
  };
}

// Sends the ball off the paddle; after a win or a loss, a new wall first.
export function launch(game: Game): void {
  if (!game.held) return;
  if (game.over) {
    game.bricks = Array(50).fill(true);
    game.score = 0;
    game.lives = 3;
    game.over = null;
  }
  game.held = false;
  game.ball.vx = SPEED * Math.sin(0.35);
  game.ball.vy = -SPEED * Math.cos(0.35);
}

// The game `dt` seconds on, the paddle under the pointer at `target`.
export function step(game: Game, dt: number, target: number): void {
  game.broken = [];
  if (game.paused) return;
  game.paddle = clamp(target, PLAY.left + PADDLE_W / 2, PLAY.right - PADDLE_W / 2);
  const ball = game.ball;
  if (game.held) {
    ball.x = game.paddle;
    ball.y = PADDLE_TOP - R;
    return;
  }
  const parts = Math.ceil(dt * 240);
  for (let n = 0; n < parts; n++) {
    ball.x += (ball.vx * dt) / parts;
    ball.y += (ball.vy * dt) / parts;
    if (ball.x - R < PLAY.left) ball.vx = Math.abs(ball.vx);
    if (ball.x + R > PLAY.right) ball.vx = -Math.abs(ball.vx);
    if (ball.y - R < PLAY.top) ball.vy = Math.abs(ball.vy);
    const off = (ball.x - game.paddle) / (PADDLE_W / 2);
    if (
      ball.vy > 0 &&
      ball.y + R >= PADDLE_TOP &&
      ball.y < PADDLE_TOP + 19 &&
      Math.abs(off) <= 1.1
    ) {
      const angle = clamp(off, -1, 1) * MAX_ANGLE;
      ball.vx = SPEED * Math.sin(angle);
      ball.vy = -SPEED * Math.cos(angle);
    }
    for (let i = 0; i < game.bricks.length; i++) {
      if (!game.bricks[i]) continue;
      const [x, y] = brickAt(i);
      const dx = ball.x - clamp(ball.x, x, x + BRICK_W);
      const dy = ball.y - clamp(ball.y, y, y + BRICK_H);
      if (dx * dx + dy * dy > R * R) continue;
      game.bricks[i] = false;
      game.broken.push(i);
      game.score += 10 * (5 - Math.floor(i / 10));
      if (Math.abs(dx) > Math.abs(dy)) ball.vx = (dx > 0 ? 1 : -1) * Math.abs(ball.vx);
      else ball.vy = (dy > 0 ? 1 : -1) * Math.abs(ball.vy);
      if (!game.bricks.some(Boolean)) {
        game.over = "won";
        game.held = true;
        ball.x = game.paddle;
        ball.y = PADDLE_TOP - R;
        return;
      }
      break;
    }
    if (ball.y - R > PLAY.bottom) {
      game.lives -= 1;
      if (game.lives <= 0) game.over = "lost";
      game.held = true;
      ball.x = game.paddle;
      ball.y = PADDLE_TOP - R;
      return;
    }
  }
}
