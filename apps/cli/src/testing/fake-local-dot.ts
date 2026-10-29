import { launchdLabels } from "../../../daemon/src/dots/service-names.ts";
import type { DotServices } from "../dots/services.ts";
import {
  type AppState,
  type KeydState,
  type LocalApi,
  LocalApiError,
  type LocalDot,
} from "../local-dot.ts";

export const HOME = "/private/fixture/.localdot";
export const DAEMON = "/apps/node/bin/node --import tsx src/main.ts";
export const KEYD = `/apps/localdot/bin/keyd -home ${HOME} -vault file`;

// An answer from the app's API: a value, a function of the request body, or a refusal.
export type Route = unknown | ((body: unknown) => unknown) | LocalApiError;

// One localDot, its services and its processes, in memory. Time passes only through sleep.
export interface Machine {
  clock: number;
  app: AppState;
  daemon?: number;
  keydPid?: number;
  keyd: KeydState;
  commands: Record<number, string>;
  // A daemon that outlives its service's stop, and one that ignores SIGTERM too.
  stubborn: boolean;
  ignoresTerm: boolean;
  // Whether a daemon its service starts comes to answer, and how its keyd starts.
  answers: boolean;
  keydStarts: KeydState;
  portHolder?: { pid: number; command: string };
  exists: boolean;
  serviceHome: string;
  login: boolean;
  docker: boolean;
  installer?: number;
  managed: boolean;
  managedDown: number;
  computersStop: boolean;
  routes: Record<string, Route>;
}

export function fakeLocalDot(overrides: Partial<Machine> = {}) {
  const m: Machine = {
    clock: 0,
    app: "running",
    daemon: 100,
    keydPid: 200,
    keyd: "ready",
    commands: { 100: DAEMON, 200: KEYD },
    stubborn: false,
    ignoresTerm: false,
    answers: true,
    keydStarts: "ready",
    exists: true,
    serviceHome: HOME,
    login: true,
    docker: true,
    managed: false,
    managedDown: 0,
    computersStop: true,
    routes: {},
    ...overrides,
  };
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const daemonGone = () => {
    m.daemon = undefined;
    m.app = m.portHolder ? "not-answering" : "stopped";
  };
  const services: DotServices = {
    manager: "launchd",
    names: launchdLabels,
    template: async () => {
      throw new Error("not used");
    },
    write: async () => false,
    exists: async () => m.exists,
    home: async () => (m.exists ? m.serviceHome : undefined),
    async start(_id, only) {
      calls.push(`start${only ? ` ${only}` : ""}`);
      // launchd starts only enabled agents, so starting enables them.
      m.login = true;
      if (m.keyd === "down") {
        m.keydPid = 201;
        m.commands[201] = KEYD;
        m.keyd = m.keydStarts;
      }
      if (only) return;
      m.daemon = 101;
      m.commands[101] = DAEMON;
      m.app = m.portHolder ? "not-answering" : m.answers ? "running" : "stopped";
    },
    async stop(_id, only) {
      calls.push(`stop${only ? ` ${only}` : ""}`);
      if (!m.stubborn && m.daemon && m.commands[m.daemon] === DAEMON) daemonGone();
      if (!only) {
        m.keydPid = undefined;
        m.keyd = "down";
      }
    },
    remove: async () => {},
    login: async () => m.login,
    async setLogin(_id, on) {
      calls.push(`login ${on ? "on" : "off"}`);
      m.login = on;
    },
  };
  const api: LocalApi = async <T>(method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    const route = m.routes[`${method} ${path}`];
    if (route instanceof LocalApiError) throw route;
    if (route === undefined) throw new LocalApiError(404, "Not Found");
    return (typeof route === "function" ? route(body) : route) as T;
  };
  const l: LocalDot = {
    home: HOME,
    port: 4750,
    signal: new AbortController().signal,
    dot: "main",
    name: "localDot",
    dotFlag: "",
    managed: m.managed,
    services,
    publicOrigins: [],
    app: async () => m.app,
    api: () => api,
    lockHolder: (lock) => (lock === "daemon" ? m.daemon : m.keydPid),
    removeLock(lock) {
      calls.push(`remove ${lock} lock`);
      if (lock === "daemon") m.daemon = undefined;
      else m.keydPid = undefined;
    },
    command: async (pid) => m.commands[pid],
    listener: async () => m.portHolder,
    kill(pid, signal) {
      calls.push(`kill ${signal} ${pid}`);
      if (pid === m.daemon && (signal === "SIGKILL" || !m.ignoresTerm)) daemonGone();
    },
    keyd: async () => m.keyd,
    docker: async () => m.docker,
    async startDocker() {
      calls.push("start docker");
      return true;
    },
    installer: () => m.installer,
    async stopComputers() {
      calls.push("stop computers");
      return m.computersStop;
    },
    async managedDown() {
      calls.push("managed down");
      return m.managedDown;
    },
    async managedUp(io) {
      calls.push("managed up");
      io.out("http://127.0.0.1:4750/#code=managed");
      return 0;
    },
    async signIn(io) {
      calls.push("sign in");
      io.out("http://127.0.0.1:4750/#code=fake");
      return 0;
    },
    logTail: (log) => [`${log} said something`],
    sleep: async (ms) => {
      m.clock += ms;
    },
    now: () => m.clock,
  };
  return { l, m, calls, io, out, err, api };
}
