import { describe, expect, it } from "vitest";
import { LiveSessions } from "../gateway/live.ts";
import { hiddenParts } from "../gateway/window-owners.ts";
import { ComputerTurns } from "./computer-turn.ts";
import { FakeDesktop } from "./testing/fake-desktop.ts";

// mulberry32: the same seed plays the same interleaving.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = "cell";
const TASKS = ["a", "b", "c"] as const;
const STEPS = 40;

async function play(seed: number) {
  const rng = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)] as T;
  const hops = async () => {
    for (let i = Math.floor(rng() * 4); i > 0; i--)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const live = new LiveSessions();
  const desktop = new FakeDesktop();
  const turns = new ComputerTurns({ live, windows: () => (request) => desktop.read(request) });
  // Who truly made each window, whoever the daemon thinks owns it.
  const madeBy = new Map<number, string>();
  const logs = new Map<string, string[]>(TASKS.map((id) => [id, []]));
  const stopped = new Set<string>();
  // A task stopped while it held the computer may finish the action it had begun.
  const held = new Set<string>();
  const ended = new Map<string, Promise<void>>();
  let acting: string | undefined;
  const trouble: string[] = [];
  const counts = { actions: 0, refused: 0, user: 0, stops: 0 };

  const act = (sessionId: string, what: () => void) => {
    if (acting) trouble.push(`${sessionId} acted while ${acting} was acting`);
    if (stopped.has(sessionId) && !held.has(sessionId))
      trouble.push(`${sessionId} acted after it was stopped`);
    acting = sessionId;
    what();
    // Whatever the computer does now is put down to the task acting.
    logs.get(live.get(CELL) ?? "nobody")?.push(sessionId);
  };
  const done = () => {
    acting = undefined;
  };

  const completed = new Map<string, number>();
  const go = Promise.withResolvers<void>();
  const task = (sessionId: string) => async (signal: AbortSignal) => {
    await go.promise;
    for (let step = 0; step < STEPS && !signal.aborted; step++) {
      completed.set(sessionId, step + 1);
      const op = rng();
      try {
        if (op < 0.08) {
          // Something outside every task takes the focus, as a notification would.
          const ids = desktop.ids();
          if (ids.length) desktop.steal(pick(ids));
          await hops();
          continue;
        }
        if (op < 0.12 && !stopped.size) {
          const victim = pick(TASKS.filter((id) => id !== sessionId));
          stopped.add(victim);
          if (live.lease(CELL).holder === victim) held.add(victim);
          counts.stops++;
          live.stop(victim);
          continue;
        }
        if (op < 0.2) {
          const user = await turns.take(sessionId, CELL, signal, true);
          act(`user:${sessionId}`, () => counts.user++);
          await hops();
          done();
          await user.release();
          continue;
        }
        const turn = await turns.take(sessionId, CELL, signal);
        try {
          const before = desktop.active;
          if (op < 0.4 || before === undefined) {
            act(sessionId, () => madeBy.set(desktop.open(), sessionId));
            await hops();
            done();
          } else {
            if (op < 0.6)
              await turn.yielding(async (resume) => {
                await hops();
                await resume();
              });
            const target = desktop.active;
            if (target !== undefined && turn.foreign(target)) {
              counts.refused++;
              const maker = madeBy.get(target);
              if (!maker || maker === sessionId || live.cellOf(maker) !== CELL)
                trouble.push(`${sessionId} was refused a window ${maker ?? "nobody"} made`);
            } else {
              // What it sees: every part of a window another task at work made is covered. An
              // ended task's windows are nobody's.
              const stack = desktop.stack();
              const covered = await turn.hidden(stack);
              const theirs = (id: number) => {
                const maker = madeBy.get(id);
                return !!maker && maker !== sessionId && live.cellOf(maker) === CELL;
              };
              for (const part of hiddenParts(stack, theirs))
                if (!covered.some((r) => JSON.stringify(r) === JSON.stringify(part)))
                  trouble.push(`${sessionId} saw part of another task's window`);
              act(sessionId, () => counts.actions++);
              const maker = target === undefined ? undefined : madeBy.get(target);
              if (maker && maker !== sessionId && live.cellOf(maker) === CELL)
                trouble.push(`${sessionId} acted on ${maker}'s window`);
              await hops();
              done();
            }
          }
        } finally {
          await turn.release();
        }
      } catch (error) {
        if (!signal.aborted) trouble.push(`${sessionId} failed: ${String(error)}`);
      }
    }
  };
  for (const id of TASKS) {
    live.start(CELL, id, task(id));
    ended.set(id, live.settled(id));
  }
  go.resolve();
  await Promise.all(ended.values());
  // Stop ends its own task and no other.
  for (const id of TASKS)
    if (!stopped.has(id) && completed.get(id) !== STEPS) trouble.push(`${id} did not finish`);
  for (const [owner, actors] of logs)
    for (const actor of actors)
      if (actor !== owner && actor !== `user:${owner}`)
        trouble.push(`${actor}'s action was put down to ${owner}`);
  return { trouble, counts, lease: live.lease(CELL), live };
}

describe("three tasks sharing one computer", () => {
  it.each(Array.from({ length: 24 }, (_, i) => i + 1))("plays seed %i safely", async (seed) => {
    const { trouble, counts, lease, live } = await play(seed);
    expect(trouble).toEqual([]);
    expect(counts.actions + counts.user).toBeGreaterThan(0);
    expect(lease.holder).toBeUndefined();
    expect(lease.waiting()).toEqual([]);
    expect(live.busy(CELL)).toBe(false);
  });

  it("refuses some foreign windows and stops some tasks across the seeds", async () => {
    let refused = 0;
    let stops = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const { counts } = await play(seed);
      refused += counts.refused;
      stops += counts.stops;
    }
    expect(refused).toBeGreaterThan(0);
    expect(stops).toBeGreaterThan(0);
  });
});
