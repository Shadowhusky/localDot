import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerTurns } from "../agent/computer-turn.ts";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { LiveSessions } from "../gateway/live.ts";
import { maskFrame } from "../gateway/mask.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// A fresh desktop of the suite's own (LOCALDOT_EVAL_* names it), never the live computer's.
const options = DOCKER_TESTS ? evalCellOptions() : undefined;
let cell: EvalCell;
let desktop: DesktopdClient;
let tools: DesktopdTools;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CELL = "shared";
const forever = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

async function waitFor<T>(what: string, find: () => Promise<T | undefined>, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await find().catch(() => undefined);
    if (found !== undefined) return found;
    await sleep(300);
  }
  throw new Error(`${what} did not appear`);
}

describe.skipIf(!DOCKER_TESTS)("two tasks working in two windows of one desktop", () => {
  beforeAll(async () => {
    if (!options) return;
    cell = await startEvalCell("shared", options);
    desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
    tools = new DesktopdTools({ baseUrl: cell.baseUrl, token: cell.token });
  });
  afterAll(async () => {
    await tools?.close();
    if (options && cell) removeEvalContainers(options, cell.name);
  });

  it("each types into its own window, turn by turn, and never into the other's", async () => {
    for (const name of ["a.txt", "b.txt"]) cell.write(`/config/${name}`, "");
    const live = new LiveSessions();
    const turns = new ComputerTurns({
      live,
      windows: () => (request, signal) => desktop.windows(request, signal),
    });
    const owners = turns.owners(CELL);
    live.start(CELL, "a", forever);
    live.start(CELL, "b", forever);
    const before = new Set((await desktop.windows({})).windows.map((w) => w.id));
    const fresh = async () =>
      (await desktop.windows({})).windows.filter((w) => !before.has(w.id) && !w.transientFor);

    // A opens its editor as the dock would, B from its shell (on a bus of its own, so it is a
    // program of its own rather than another window of A's); neither waits for it to show.
    let turn = await turns.take("a", CELL, AbortSignal.timeout(20_000));
    await desktop.launch({ app: "mousepad", args: ["/config/a.txt"] });
    await turn.release();
    const command = randomUUID();
    owners.shell(command, "b");
    turn = await turns.take("b", CELL, AbortSignal.timeout(20_000));
    await tools.shell(
      {
        id: command,
        command: "nohup dbus-run-session -- mousepad /config/b.txt >/dev/null 2>&1 &",
        timeoutMs: 10_000,
      },
      () => {},
    );
    await turn.release();
    const windows = await waitFor("both editors", async () => {
      const shown = await fresh();
      return shown.length >= 2 ? shown : undefined;
    });
    // Whatever the turns saw first, each window is put down to the task that opened it.
    for (const id of ["a", "b"])
      await (await turns.take(id, CELL, AbortSignal.timeout(20_000))).release();
    const mine = (id: string) => windows.filter((w) => owners.ownerOf(w.id) === id);
    expect(mine("a")).toHaveLength(1);
    expect(mine("b")).toHaveLength(1);

    let acting: string | undefined;
    const overlaps: string[] = [];
    const typed = async (id: "a" | "b", word: string) => {
      for (const letter of word) {
        const turn = await turns.take(id, CELL, AbortSignal.timeout(30_000));
        try {
          if (acting) overlaps.push(`${id} with ${acting}`);
          acting = id;
          const state = await desktop.windows({});
          const front = state.windows.find((w) => w.active)?.id;
          expect(owners.ownerOf(front ?? 0)).toBe(id);
          expect(turn.foreign(front)).toBe(false);
          await desktop.input({
            input: { kind: "key", combo: [letter] },
            injector: "xtest",
            holdMs: 0,
            window: front,
          });
          await sleep(20);
        } finally {
          acting = undefined;
          await turn.release();
        }
        // Each thinks between its actions, as a model does.
        await sleep(Math.floor(Math.random() * 60));
      }
      const save = await turns.take(id, CELL, AbortSignal.timeout(30_000));
      try {
        const front = (await desktop.windows({})).windows.find((w) => w.active)?.id;
        await desktop.input({
          input: { kind: "key", combo: ["ctrl", "s"] },
          injector: "xtest",
          holdMs: 0,
          window: front,
        });
        await sleep(500);
      } finally {
        await save.release();
      }
    };
    const started = Date.now();
    await Promise.all([typed("a", "alphaalpha"), typed("b", "bravobravo")]);
    console.log(`two tasks typed 20 letters in turns in ${Date.now() - started} ms`);
    expect(overlaps).toEqual([]);
    const read = (name: string) => cell.read(`/config/${name}`)?.toString("utf8").trim();
    await waitFor(
      "a's file",
      async () => (read("a.txt") === "alphaalpha" ? true : undefined),
      10_000,
    );
    await waitFor(
      "b's file",
      async () => (read("b.txt") === "bravobravo" ? true : undefined),
      10_000,
    );
    // What A sees: B's editor is covered wherever it shows, A's own is not.
    const look = await turns.take("a", CELL, AbortSignal.timeout(30_000));
    try {
      const o = await desktop.observe();
      const hidden = await look.hidden(o.windows);
      const theirs = o.windows.find((w) => owners.ownerOf(w.id) === "b");
      const own = o.windows.find((w) => owners.ownerOf(w.id) === "a");
      expect(theirs && own).toBeTruthy();
      expect(hidden.length).toBeGreaterThan(0);
      const pixels = await sharp(
        await maskFrame(Buffer.from(o.image, "base64"), hidden, cell.scale),
      )
        .removeAlpha()
        .raw()
        .toBuffer();
      const grey = (x: number, y: number) => {
        const at = (Math.floor(y / cell.scale) * 1280 + Math.floor(x / cell.scale)) * 3;
        return pixels[at] === 0x5b && pixels[at + 1] === 0x5e && pixels[at + 2] === 0x66;
      };
      for (const part of hidden) expect(grey(part.x + part.w / 2, part.y + part.h / 2)).toBe(true);
      const mine = own?.frame;
      if (mine) expect(grey(mine.x + mine.w / 2, mine.y + mine.h / 2)).toBe(false);
    } finally {
      await look.release();
    }
    for (const id of ["a", "b"]) live.stop(id);
  });
});
