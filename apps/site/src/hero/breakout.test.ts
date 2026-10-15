import { describe, expect, it } from "vitest";
import { brickAt, type Game, launch, newGame, PADDLE_TOP, R, step } from "./breakout.ts";

// A ball in flight across an empty field, nothing scored yet.
const flying = (x: number, y: number, vx: number, vy: number): Game => ({
  ...newGame(Array(50).fill(false), 960),
  ball: { x, y, vx, vy },
  held: false,
  score: 0,
});

describe("the Breakout the visitor takes over", () => {
  it("bounces the ball off the walls", () => {
    const game = flying(250 + R, 700, -900, 0);
    step(game, 1 / 60, 960);
    expect(game.ball.vx).toBeGreaterThan(0);
  });

  it("breaks the brick the ball runs into and turns the ball back", () => {
    const [x, y] = brickAt(12);
    const game = flying(x + 60, y + 41 + R + 2, 0, -900);
    game.bricks[12] = true;
    step(game, 1 / 60, 960);
    expect(game.bricks[12]).toBe(false);
    expect(game.broken).toEqual([12]);
    expect(game.ball.vy).toBeGreaterThan(0);
  });

  it("sends the ball off the paddle at an angle from where it lands", () => {
    const game = flying(960 + 80, PADDLE_TOP - R - 2, 0, 900);
    step(game, 1 / 60, 960);
    expect(game.ball.vy).toBeLessThan(0);
    expect(game.ball.vx).toBeGreaterThan(0);
  });

  it("picks up the recorded score and lives with the bricks already gone", () => {
    const bricks = Array.from({ length: 50 }, (_, n) => n >= 10);
    const game = newGame(bricks, 960, 2);
    expect(game.score).toBe(500);
    expect(game.lives).toBe(2);
    expect(newGame(Array(50).fill(true), 960).score).toBe(0);
  });

  it("stands still while paused", () => {
    const game = flying(700, 700, 300, -300);
    game.paused = true;
    step(game, 1 / 60, 960);
    expect(game.ball).toEqual({ x: 700, y: 700, vx: 300, vy: -300 });
  });

  it("puts a lost ball back on the paddle until it is launched", () => {
    const game = flying(700, 1115, 0, 900);
    step(game, 1 / 60, 800);
    expect(game.held).toBe(true);
    expect(game.ball.x).toBeCloseTo(800);
  });

  it("moves the paddle to the pointer but keeps it inside the panel", () => {
    const game = newGame(Array(50).fill(true), 960);
    step(game, 1 / 60, 5000);
    expect(game.paddle).toBeLessThan(1679);
  });

  it("scores each brick, more for the higher rows", () => {
    const [x, y] = brickAt(3);
    const game = flying(x + 60, y + 41 + R + 2, 0, -900);
    game.bricks[3] = true;
    step(game, 1 / 60, 960);
    expect(game.score).toBe(50);
  });

  it("takes a life for a lost ball and ends the game when none are left", () => {
    const game = flying(700, 1115, 0, 900);
    game.lives = 1;
    step(game, 1 / 60, 800);
    expect(game.lives).toBe(0);
    expect(game.over).toBe("lost");
  });

  it("wins when the last brick goes, and a launch then starts a new wall", () => {
    const [x, y] = brickAt(49);
    const game = flying(x + 60, y + 41 + R + 2, 0, -900);
    game.bricks[49] = true;
    step(game, 1 / 60, 960);
    expect(game.over).toBe("won");
    expect(game.held).toBe(true);
    launch(game);
    expect(game.bricks.every(Boolean)).toBe(true);
    expect(game.over).toBe(null);
    expect(game.lives).toBe(3);
    expect(game.score).toBe(0);
  });
});
