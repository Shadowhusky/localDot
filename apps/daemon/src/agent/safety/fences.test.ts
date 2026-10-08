import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTONOMY, type PauseSnapshot, ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { EventLog } from "../../event-log.ts";
import { ComputerFences } from "./fences.ts";
import { SafetyIntentStore } from "./store.ts";

const homes: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync("/tmp/ld-fences-");
  homes.push(dir);
  return dir;
}
function open(dir: string): EventLog {
  const log = new EventLog(dir);
  logs.push(log);
  return log;
}
// Startup order in main.ts: the event log recovers first, then the fences read their records.
function restart(dir: string): ComputerFences {
  for (const log of logs.splice(0)) log.close();
  open(dir);
  return new ComputerFences(dir);
}
function stopService(): void {
  for (const log of logs.splice(0)) log.close();
}
function pause(phase: PauseSnapshot["phase"]): PauseSnapshot {
  return {
    requestId: ulid(),
    revision: 1,
    reason: "user",
    phase,
    atStepBoundary: phase === "paused",
    resumeAvailable: phase === "paused",
  };
}

it("deleting a session from history fences no computer at the next start", () => {
  const dir = home(),
    log = open(dir),
    cellId = ulid();
  const kept = log.createSession("kept task");
  new SafetyIntentStore(dir).write(kept, cellId, DEFAULT_AUTONOMY, pause("paused"), "api");
  log.forget(log.createSession("deleted task"));
  const fences = restart(dir);
  expect(fences.isFenced(cellId)).toBe(false);
  expect(fences.isFenced(ulid())).toBe(false);
  expect(fences.records()).toEqual([]);
  expect(readdirSync(join(dir, "sessions"))).toEqual([kept]);
});

it("staging, stray files and other non-owners beside the sessions fence nothing", () => {
  const dir = home(),
    sessions = join(dir, "sessions"),
    crashed = ulid(),
    cellId = ulid();
  new SafetyIntentStore(dir).write(crashed, cellId, DEFAULT_AUTONOMY, pause("pausing"), "api");
  mkdirSync(join(sessions, ".deleting", ulid()), { recursive: true, mode: 0o700 });
  mkdirSync(join(sessions, "notes"), { mode: 0o700 });
  writeFileSync(join(sessions, ".DS_Store"), "finder");
  writeFileSync(join(sessions, ulid()), "not a session directory");
  const public_ = join(sessions, ulid());
  mkdirSync(public_, { mode: 0o700 });
  chmodSync(public_, 0o755);
  const fences = new ComputerFences(dir);
  expect(fences.isFenced(cellId)).toBe(true);
  expect(fences.isFenced(ulid())).toBe(false);
  expect(fences.record(cellId)).toMatchObject({ cellId, sessionId: crashed, executor: "api" });
});

it("more than 1,024 sessions never close admission for every computer", () => {
  const dir = home(),
    store = new SafetyIntentStore(dir),
    crashed = ulid(),
    cellId = ulid();
  store.write(crashed, cellId, DEFAULT_AUTONOMY, pause("uncertain"), "api");
  for (let i = 0; i < 1025; i++) mkdirSync(join(dir, "sessions", ulid()), { mode: 0o700 });
  const fences = new ComputerFences(dir);
  expect(fences.isFenced(ulid())).toBe(false);
  expect(fences.isFenced(cellId)).toBe(true);
  expect(fences.record(cellId)?.sessionId).toBe(crashed);
});

it("a refused intent fences only the computer it names", () => {
  const dir = home(),
    store = new SafetyIntentStore(dir),
    session = ulid(),
    named = ulid(),
    other = ulid();
  store.write(session, named, DEFAULT_AUTONOMY, pause("paused"), "api");
  chmodSync(join(dir, "sessions", session, "safety.json"), 0o644);
  const fences = new ComputerFences(dir);
  expect(fences.isFenced(named)).toBe(true);
  expect(fences.isFenced(other)).toBe(false);
  // Its executor cannot be trusted, so the fence never admits Replace computer as an API task.
  expect(fences.record(named)).toEqual({
    cellId: named,
    sessionId: session,
    revision: 1,
    executor: "native",
    nativeRetired: false,
  });
});

it("a refused intent fences its computer even after its task recorded its end", () => {
  const dir = home(),
    log = open(dir),
    cellId = ulid(),
    session = log.createSession("tampered after stop");
  new SafetyIntentStore(dir).write(session, cellId, DEFAULT_AUTONOMY, pause("pausing"), "api");
  log.append(session, { type: "session.end", agent: "main", data: { reason: "stopped" } });
  chmodSync(join(dir, "sessions", session, "safety.json"), 0o644);
  const fences = restart(dir);
  expect(fences.isFenced(cellId)).toBe(true);
  expect(fences.record(cellId)).toMatchObject({ executor: "native", nativeRetired: false });
});

it("an unsettled intent fences after a crash but not once its task recorded its end", () => {
  const dir = home(),
    log = open(dir),
    store = new SafetyIntentStore(dir);
  const crashedCell = ulid(),
    endedCell = ulid();
  const crashed = log.createSession("crashed mid-pause"),
    ended = log.createSession("stopped mid-pause");
  store.write(crashed, crashedCell, DEFAULT_AUTONOMY, pause("pausing"), "api");
  store.write(ended, endedCell, DEFAULT_AUTONOMY, pause("pausing"), "api");
  log.append(crashed, { type: "agent.state", agent: "main", data: { state: "thinking" } });
  log.append(ended, { type: "session.end", agent: "main", data: { reason: "stopped" } });
  const fences = restart(dir);
  expect(fences.isFenced(crashedCell)).toBe(true);
  expect(fences.isFenced(endedCell)).toBe(false);
});

it("reading the fences while the service is stopped leaves a finished task's intent unfenced", () => {
  const dir = home(),
    log = open(dir),
    cellId = ulid(),
    session = log.createSession("paused, then stopped by an older build");
  new SafetyIntentStore(dir).write(session, cellId, DEFAULT_AUTONOMY, pause("resuming"), "native");
  log.append(session, { type: "session.end", agent: "main", data: { reason: "stopped" } });
  stopService();
  expect(new ComputerFences(dir).records()).toEqual([]);
  expect(readdirSync(join(dir, "safety", "fences"))).toEqual([]);
  expect(restart(dir).isFenced(cellId)).toBe(false);
});

it("an unsettled intent still fences when its task log cannot be read", () => {
  const dir = home(),
    log = open(dir),
    cellId = ulid(),
    session = log.createSession("crashed mid-pause");
  new SafetyIntentStore(dir).write(session, cellId, DEFAULT_AUTONOMY, pause("pausing"), "api");
  stopService();
  const events = join(dir, "sessions", session, "events.jsonl");
  rmSync(events, { force: true });
  mkdirSync(events);
  const fences = new ComputerFences(dir);
  expect(fences.isFenced(cellId)).toBe(true);
  expect(fences.isFenced(ulid())).toBe(false);
  expect(fences.record(cellId)).toMatchObject({ cellId, sessionId: session, executor: "api" });
});
