import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { sealSecret, ulid } from "@localdot/protocol";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import { ShellTerminationError } from "../../../../cells/desktop/desktopd/src/tools/shell.ts";
import { DockerClient } from "../cells/docker.ts";
import type { CellControls } from "../cells/orchestrator.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { KillSwitch } from "../gateway/kill-switch.ts";
import { LiveSessions } from "../gateway/live.ts";
import { KeydClient } from "../keyd/client.ts";
import { startKeyd } from "../keyd/testing/keyd-process.ts";
import { actPolicy } from "./policy.ts";
import { redactor } from "./redact.ts";
import { AgentRunner } from "./runner.ts";
import { cleanupAcceptance } from "./testing/acceptance-cleanup.ts";
import { toolHarness } from "./testing/harness.ts";
import { dispatchTool } from "./tools/index.ts";

const execute = promisify(execFile);
const image = process.env.LOCALDOT_TASK15_BRAIN_IMAGE;
const command = async (...args: string[]) =>
  (await execute("docker", args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
const enabled =
  process.env.LOCALDOT_DOCKER_TESTS === "1" && process.env.LOCALDOT_TASK15_TESTS === "1";
const CANARY = "task15-local-canary-never-real";
type Beat = { role: string; pid: number; sid: number };
const workerCode = (role: string) =>
  `const http=require('node:http'),fs=require('node:fs');const body=JSON.stringify({role:${JSON.stringify(role)},pid:process.pid,sid:Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[5])});const beat=()=>{const r=http.request(process.env.HEARTBEAT,{method:'POST'},res=>res.resume());r.on('error',()=>{});r.end(body)};beat();setInterval(beat,40);`;
const parentCode = `const cp=require('node:child_process');const normal=cp.spawn(process.execPath,['-e',${JSON.stringify(workerCode("normal"))}],{stdio:'ignore'});const escaped=cp.spawn(process.execPath,['-e',${JSON.stringify(workerCode("escaped"))}],{detached:true,stdio:'ignore'});escaped.unref();process.on('SIGTERM',()=>process.exit(0));${workerCode("parent")}`;

async function fixture(cellId = ulid(), sessionId = ulid()) {
  if (!image || !process.env.LOCALDOT_KEYD_BIN)
    throw new Error("Task15 needs reviewed fixture image and keyd fixture binary");
  const tag = `task15-stop-${randomBytes(6).toString("hex")}`;
  const name = `${tag}-desktop`,
    network = `${tag}-net`;
  const home = mkdtempSync("/tmp/ld-t15-stop-keyd-");
  const hits: Beat[] = [],
    trace: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      hits.push(JSON.parse(body));
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let keyd: Awaited<ReturnType<typeof startKeyd>> | undefined;
  let networkCreated = false;
  let container: string | undefined;
  let settle: (() => void) | undefined;
  const live = new LiveSessions();
  const cleanup = async () => {
    const errors: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    settle?.();
    await attempt(() => live.settled(sessionId));
    const ownedContainer = container;
    if (ownedContainer)
      await attempt(async () => {
        const inspect = JSON.parse(await command("inspect", ownedContainer))[0];
        expect(inspect.Config.Labels["localdot.acceptance"]).toBe(tag);
        await command("rm", "-fv", ownedContainer);
      });
    if (networkCreated)
      await attempt(async () => {
        const inspect = JSON.parse(await command("network", "inspect", network))[0];
        expect(inspect.Labels["localdot.acceptance"]).toBe(tag);
        await command("network", "rm", network);
      });
    server.closeAllConnections();
    await attempt(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const ownedKeyd = keyd;
    if (ownedKeyd) await attempt(() => ownedKeyd.stop());
    if (errors.length) throw new AggregateError(errors, "owned fixture cleanup uncertain");
  };
  try {
    keyd = await startKeyd({ home, ports: { from: 4794, to: 4794 } });
    const client = new KeydClient(keyd.socketPath);
    const binding = {
      id: "fixture",
      kind: "http" as const,
      hosts: ["provider.example.test"],
      header: "Authorization",
      format: "bearer" as const,
    };
    await client.putSecret(
      binding,
      await sealSecret((await client.status()).sealKey, binding, CANARY),
    );
    await client.openCell({ cellId, role: "desktop", port: 4794, secrets: ["fixture"] });
    await command("network", "create", "--label", `localdot.acceptance=${tag}`, network);
    networkCreated = true;
    const docker = new DockerClient();
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    live.start(cellId, sessionId, (signal) => {
      signal.addEventListener("abort", () => trace.push("abort"), { once: true });
      return pending;
    });
    let failPause = false,
      failStop = false;
    const controls: CellControls = {
      waitedForOperation: false,
      pause: async () => {
        trace.push("pause");
        if (failPause) throw new Error("owned pause failure");
        await docker.request({ method: "POST", path: `/containers/${container}/pause` });
      },
      stop: async () => {
        trace.push("stop");
        if (failStop) throw new Error("owned stop failure");
        await docker.request({
          method: "POST",
          path: `/containers/${container}/stop`,
          query: { t: "1" },
        });
      },
      unpause: async () => {
        throw new Error("never thaw in Stop acceptance");
      },
      start: async () => {
        throw new Error("never restart in Stop acceptance");
      },
    };
    const kill = new KillSwitch({
      live,
      settleMs: 50,
      keyd: {
        revoke: async (id) => {
          trace.push("revoke");
          const result = await client.revoke(id);
          trace.push("revoked");
          return result;
        },
        close: async (id) => {
          trace.push("close-keyd");
          await client.closeCell(id);
        },
        refresh: async () => {
          throw new Error("never refresh during Stop");
        },
        isWired: async () => true,
      },
      cells: {
        get: () => ({
          id: cellId,
          state: "ready",
          scale: 1,
          createdAt: "fixture",
          stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
        }),
        record: () => undefined,
        withLifecycle: async (_id, work) => work(controls),
      },
    });
    container = await command(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `localdot.acceptance=${tag}`,
      "--network",
      network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "384m",
      "--pids-limit",
      "128",
      "-e",
      `HEARTBEAT=http://host.docker.internal:${port}`,
      "--entrypoint",
      "node",
      image,
      "-e",
      parentCode,
    );
    await expect.poll(() => new Set(hits.map((h) => h.role)).size, { timeout: 5000 }).toBe(3);
    const escaped = hits.find((h) => h.role === "escaped");
    expect(escaped?.sid).toBe(escaped?.pid);
    expect(escaped?.sid).not.toBe(hits.find((h) => h.role === "normal")?.sid);
    return {
      kill,
      live,
      client,
      sessionId,
      cellId,
      trace,
      hits,
      home,
      cleanup,
      failure: (pause: boolean, stop = false) => {
        failPause = pause;
        failStop = stop;
      },
      inspect: async () => JSON.parse(await command("inspect", container as string))[0],
      quiet: async () => {
        await sleep(150);
        const count = hits.length;
        await sleep(350);
        expect(hits).toHaveLength(count);
      },
    };
  } catch (error) {
    await cleanup();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function runnerFor(h: ReturnType<typeof toolHarness>, f: Awaited<ReturnType<typeof fixture>>) {
  const unexpected = async (): Promise<never> => {
    throw new Error("containment fixture must not start a brain");
  };
  return new AgentRunner({
    eventLog: h.eventLog,
    live: f.live,
    cell: (id) => ({
      id,
      state: "ready",
      scale: 1,
      createdAt: "fixture",
      stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
    }),
    brains: { open: unexpected, start: unexpected, close: unexpected, exited: unexpected },
    keyd: f.client,
    settings: () => ({}),
    catalog: () => undefined,
    memory: { readBoth: () => ({ user: "", memory: "" }) },
    transcripts: h.transcripts,
    installSkills: unexpected,
    waitForUploads: async () => {},
    stopSession: (id) => f.kill.stopSession(id),
  });
}

describe.skipIf(!enabled)("actual container-wide Stop containment", () => {
  it("revokes before globally freezing an ordinary child and a detached new-session child", async () => {
    const f = await fixture();
    try {
      expect((await f.client.cell(f.cellId))?.surrogates).toHaveLength(1);
      const outcome = await f.kill.stopSession(f.sessionId);
      expect(outcome).toEqual({
        revoked: true,
        paused: true,
        closed: false,
        stopped: false,
        errors: [],
      });
      expect(f.trace).toEqual(["abort", "revoke", "revoked", "pause"]);
      expect((await f.inspect()).State).toMatchObject({ Running: true, Paused: true });
      expect((await f.client.cell(f.cellId))?.surrogates).toHaveLength(0);
      await f.quiet();
    } finally {
      await f.cleanup();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  it("closes key access and stops the whole container if freezing fails", async () => {
    const f = await fixture();
    try {
      f.failure(true);
      const outcome = await f.kill.stopSession(f.sessionId);
      expect(outcome).toMatchObject({ revoked: true, paused: false, closed: true, stopped: true });
      expect(f.trace).toEqual(["abort", "revoke", "revoked", "pause", "close-keyd", "stop"]);
      expect((await f.inspect()).State.Running).toBe(false);
      expect(await f.client.cell(f.cellId)).toBeUndefined();
      await f.quiet();
    } finally {
      await f.cleanup();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  it("preserves typed shell cleanup uncertainty through HTTP and stops an already-fenced session", async () => {
    const h = toolHarness(),
      f = await fixture(h.session.cellId, h.session.id);
    let requests = 0,
      containment = 0;
    const app = new Hono();
    app.use("*", async (c, next) => {
      requests++;
      expect(c.req.header("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
      await next();
    });
    addToolRoutes(app, {
      home: h.home,
      env: {},
      browser: {
        read: async () => {
          throw new Error("unused");
        },
        navigate: async () => {
          throw new Error("unused");
        },
      },
      runShell: async () => {
        throw new ShellTerminationError(123, new Error("private fixture diagnostic"));
      },
    });
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => ready());
    await listening;
    const tools = new DesktopdTools({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "t".repeat(43),
    });
    h.tools.desktop = () => tools;
    const runner = runnerFor(h, f);
    h.tools.stopForUncertainty = async (session, reason) => {
      containment++;
      expect(reason).toBe("shell_cleanup_uncertain");
      expect(session.stopped).toBe(true);
      await runner.contain(session, reason);
    };
    try {
      const result = await dispatchTool(
        { tools: h.tools, policy: actPolicy },
        h.session,
        "shell",
        "uncertain",
        { command: "owned-fixture-command" },
        redactor([]),
      );
      expect(result.result).toMatchObject({ ok: false, final: true });
      expect(containment).toBe(1);
      expect(h.session.stopped).toBe(true);
      await dispatchTool(
        { tools: h.tools, policy: actPolicy },
        h.session,
        "shell",
        "late",
        { command: "must-not-run" },
        redactor([]),
      );
      expect(requests).toBe(1);
      await expect(runner.start(h.session.cellId, "later task")).rejects.toThrow(
        "cleanup needs attention",
      );
      expect(
        h.events().filter((e) => e.type === "task.result" || (e.type === "tool.end" && e.data.ok)),
      ).toEqual([]);
      expect((await f.inspect()).State.Paused).toBe(true);
      await f.quiet();
    } finally {
      await cleanupAcceptance([
        () => runner.close(),
        () => tools.close(),
        async () => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        },
        () => f.cleanup(),
        async () => h.session.stop(),
        async () => h.eventLog.close(),
      ]);
      rmSync(h.home, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  it("keeps the runner fenced when both real containment controls fail", async () => {
    const h = toolHarness();
    const f = await fixture(h.session.cellId, h.session.id);
    const runner = runnerFor(h, f);
    try {
      f.failure(true, true);
      h.session.stop();
      await expect(runner.contain(h.session, "shell_cleanup_uncertain")).rejects.toThrow(
        "containment could not be confirmed",
      );
      expect(await f.client.cell(f.cellId)).toBeUndefined();
      expect((await f.inspect()).State).toMatchObject({ Running: true, Paused: false });
      const count = f.hits.length;
      await expect.poll(() => f.hits.length).toBeGreaterThan(count);
      await expect(runner.start(h.session.cellId, "must stay blocked")).rejects.toThrow(
        "cleanup needs attention",
      );
      expect(h.session.stopped).toBe(true);
      expect(h.session.generation).toBeUndefined();
    } finally {
      await cleanupAcceptance([
        () => runner.close(),
        () => f.cleanup(),
        async () => h.session.stop(),
        async () => h.eventLog.close(),
      ]);
      rmSync(h.home, { recursive: true, force: true });
      rmSync(f.home, { recursive: true, force: true });
    }
  });
});
