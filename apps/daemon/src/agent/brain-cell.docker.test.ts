import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { DEFAULT_AGENT_LIMITS, sealSecret, type TaskPricing, ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient, DockerError, type DockerRequest } from "../cells/docker.ts";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd } from "../keyd/testing/keyd-process.ts";
import { type BrainCell, BrainCells, BrainCleanupError, homeLabel } from "./brain-cell.ts";
import { cleanupAcceptance } from "./testing/acceptance-cleanup.ts";
import { toolHarness } from "./testing/harness.ts";
import { openFixtureBrainGate } from "./testing/model-admission.ts";

const execute = promisify(execFile);
const enabled =
  process.env.LOCALDOT_DOCKER_TESTS === "1" && process.env.LOCALDOT_TASK15_TESTS === "1";
const TOOL_PORT = 4796;
const KEYD_PORT = 4795;
const CANARY = "task15-local-canary-never-real";
const PRICING: TaskPricing = {
  v: 1,
  routes: [
    {
      route: "fixture",
      models: [
        { id: "fixture-brain", inputUSDPerMTok: 1, outputUSDPerMTok: 1, maxOutputTokens: 200 },
      ],
    },
  ],
};
const run = `task15-${randomBytes(6).toString("hex")}`;
const brainImage = process.env.LOCALDOT_TASK15_BRAIN_IMAGE;
const gateImage = process.env.LOCALDOT_TASK15_GATE_IMAGE;
let keyd: KeydProcess;
let keydHome: string;
let client: KeydClient;
let cleanupUncertain = false;
async function cleanupFixture(actions: readonly (() => Promise<unknown>)[]) {
  try {
    await cleanupAcceptance(actions);
  } catch (error) {
    cleanupUncertain = true;
    throw error;
  }
}
const docker = new DockerClient();
const command = async (...args: string[]) =>
  (await execute("docker", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

async function cleanupProbe(name: string) {
  let found: { Id: string; Config: { Labels: Record<string, string> } } | undefined;
  try {
    found = JSON.parse(await command("inspect", name))[0];
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (
      failure.code !== 1 ||
      typeof failure.stderr !== "string" ||
      failure.stderr.trim().toLowerCase() !== `error: no such object: ${name}`
    )
      throw new Error("owned probe cleanup could not be confirmed", { cause: error });
  }
  if (found) {
    expect(found.Config.Labels["localdot.acceptance"], "probe ownership changed").toBe(run);
    await command("rm", "-fv", found.Id);
  }
}
async function probe(network: string, code: string): Promise<unknown> {
  const name = `${run}-probe-${ulid().toLowerCase()}`;
  try {
    const output = await command(
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      `localdot.acceptance=${run}`,
      "--network",
      network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--pids-limit",
      "32",
      "--entrypoint",
      "node",
      brainImage as string,
      "-e",
      code,
    );
    return JSON.parse(output);
  } finally {
    // A timed-out CLI can leave its container behind. Delete only this exact, owned identity.
    await cleanupFixture([() => cleanupProbe(name)]);
  }
}

function manager(home: string, request = docker.request.bind(docker)) {
  return new BrainCells({
    docker: { request },
    keyd: client,
    images: { brain: brainImage as string, gate: gateImage as string },
    home,
    range: { from: KEYD_PORT, to: KEYD_PORT },
    desktopPorts: () => [],
    namePrefix: `${run}-`,
    toolPort: TOOL_PORT,
    pollMs: 100,
  });
}
async function noOwnedResources(home: string) {
  const filters = JSON.stringify({ label: [`localdot.home=${homeLabel(home)}`] });
  expect(
    await docker.request<unknown[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters },
    }),
  ).toEqual([]);
  expect(
    await docker.request<unknown[]>({ method: "GET", path: "/networks", query: { filters } }),
  ).toEqual([]);
  expect(
    await docker.request<unknown[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ label: [`localdot.acceptance=${run}`] }) },
    }),
  ).toEqual([]);
}
async function shutdown(server: ReturnType<typeof serve>) {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe.skipIf(!enabled)("reviewed brain and gate in real Docker", () => {
  beforeAll(async () => {
    if (!brainImage || !gateImage || !process.env.LOCALDOT_KEYD_BIN)
      throw new Error(
        "Task15 needs explicitly built brain/gate images and its localdot_acceptance keyd fixture binary",
      );
    keydHome = mkdtempSync("/tmp/ld-t15-keyd-");
    keyd = await startKeyd({ home: keydHome, ports: { from: KEYD_PORT, to: KEYD_PORT } });
    client = new KeydClient(keyd.socketPath);
    const binding = {
      id: "fixture",
      kind: "llm" as const,
      provider: "openai-compatible" as const,
      baseURL: "https://provider.example.test/v1",
    };
    await client.putSecret(
      binding,
      await sealSecret((await client.status()).sealKey, binding, CANARY),
    );
  });
  afterAll(async () => {
    await keyd?.stop();
    if (keydHome && !cleanupUncertain) rmSync(keydHome, { recursive: true, force: true });
  });

  it("boots through the tool relay, calls a real keyd gateway with a canary provider and finishes", async () => {
    const h = toolHarness();
    const brains = manager(h.home);
    const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: TOOL_PORT });
    let cell: BrainCell | undefined;
    try {
      cell = await brains.open({
        initialModelAdmission: "paused",
        sessionId: h.session.id,
        secrets: ["fixture"],
        pricing: PRICING,
        budgetUSD: 5,
      });
      h.session.toolToken = cell.toolToken;
      h.session.boot = {
        sessionId: h.session.id,
        task: "Say you are done",
        models: {
          main: {
            route: "fixture",
            client: "openai-compatible",
            model: "fixture-brain",
            surrogate: cell.surrogates.fixture,
            computer: "none",
            coords: "pixels",
            vision: false,
            reasoning: false,
            contextTokens: 200000,
            maxOutputTokens: 200,
          },
        },
        proxy: { url: cell.proxyUrl, token: cell.proxyToken },
        memory: { user: "", memory: "" },
        skills: [],
        limits: DEFAULT_AGENT_LIMITS,
        resume: false,
        inboxAfter: 0,
      };
      await openFixtureBrainGate(client, cell, h.session.id);
      await brains.start(cell);
      const code = await brains.exited(cell, AbortSignal.timeout(20000));
      expect(code, await command("logs", cell.names.brain)).toBe(0);
      expect(h.events().filter((e) => e.type === "task.result")).toMatchObject([
        { data: { summary: "Done in a cell" } },
      ]);
      expect((await client.cell(cell.id))?.task?.id).toBe(h.session.id);
      expect(JSON.stringify(h.events())).not.toContain(CANARY);
      const inspect = JSON.parse(await command("inspect", cell.names.brain))[0];
      expect(inspect.Config.User).toBe("node");
      expect(inspect.HostConfig).toMatchObject({
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
      });
    } finally {
      await cleanupFixture([
        async () => {
          if (cell) await brains.close(cell);
        },
        () => shutdown(server),
        () => noOwnedResources(h.home),
        async () => h.session.stop(),
        async () => h.eventLog.close(),
      ]);
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("has an isolated bridge without default routes or DNS and reaches host services only through its gate", async () => {
    const h = toolHarness();
    const brains = manager(h.home);
    const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: TOOL_PORT });
    let cell: BrainCell | undefined;
    try {
      cell = await brains.open({
        initialModelAdmission: "paused",
        sessionId: h.session.id,
        secrets: ["fixture"],
        pricing: PRICING,
        budgetUSD: 5,
      });
      h.session.toolToken = cell.toolToken;
      const network = JSON.parse(
        await command("network", "inspect", cell.names.internalNetwork),
      )[0];
      expect(network.Internal).toBe(true);
      expect(network.EnableIPv6).toBe(false);
      expect(network.Options["com.docker.network.bridge.gateway_mode_ipv4"]).toBe("isolated");
      const tested = await probe(
        cell.names.internalNetwork,
        `const net=require('node:net'), dns=require('node:dns').promises, fs=require('node:fs'); const tcp=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(1500);s.once('connect',()=>{s.destroy();resolve('connected')});s.once('timeout',()=>{s.destroy();resolve('timeout')});s.once('error',e=>resolve(e.code))});(async()=>{const routes=fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1).map(x=>x.trim().split(/\\s+/)); const dnsResult=await dns.lookup('provider.example.test').then(()=> 'resolved', e=>e.code); console.log(JSON.stringify({defaultRoutes:routes.filter(r=>r[1]==='00000000').length,dns:dnsResult,direct:await tcp('198.51.100.1',443),host:await dns.lookup('host.docker.internal').then(()=> 'resolved', e=>e.code),egress:await tcp('${cell.gateEgressIp}',3128),gate:await tcp('${cell.gateInternalIp}',3128),tool:await tcp('${cell.gateInternalIp}',4751),wrong:await tcp('${cell.gateInternalIp}',8081)}));})()`,
      );
      expect(tested).toMatchObject({ defaultRoutes: 0, gate: "connected", tool: "connected" });
      const values = tested as Record<string, unknown>;
      expect(["ENETUNREACH", "EHOSTUNREACH"]).toContain(values.direct);
      expect(["ENETUNREACH", "EHOSTUNREACH"]).toContain(values.egress);
      expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(values.dns);
      expect(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]).toContain(values.host);
      expect(values.wrong).not.toBe("connected");
      // A positive HTTP roundtrip proves the relays, not just TCP acceptance by socat.
      const relayed = await probe(
        cell.names.internalNetwork,
        `const http=require('node:http'); const req=http.request({host:'${cell.gateInternalIp}',port:3128,path:'http://keyd.ldot/health',headers:{'proxy-authorization':'Basic '+Buffer.from('brain:${cell.proxyToken}').toString('base64')}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>console.log(JSON.stringify({status:res.statusCode,body:JSON.parse(text)})));});req.setTimeout(3000,()=>req.destroy());req.end();`,
      );
      expect(relayed).toMatchObject({ status: 200, body: { ok: true, cell: cell.id } });
      const wrongSide = await probe(
        cell.names.egressNetwork,
        `const net=require('node:net');let left=2;const out={};for(const port of [3128,4751]){const s=net.connect({host:'${cell.gateEgressIp}',port});s.setTimeout(1500);const done=value=>{out[port]=value;if(!--left)console.log(JSON.stringify(out));};s.once('connect',()=>{s.destroy();done('connected')});s.once('timeout',()=>{s.destroy();done('timeout')});s.once('error',e=>done(e.code));}`,
      );
      expect(Object.values(wrongSide as object)).not.toContain("connected");
    } finally {
      await cleanupFixture([
        async () => {
          if (cell) await brains.close(cell);
        },
        () => shutdown(server),
        () => noOwnedResources(h.home),
        async () => h.session.stop(),
        async () => h.eventLog.close(),
      ]);
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  it("runs unprivileged with no capabilities and a read-only filesystem", async () => {
    const outcome = await probe(
      "none",
      `const fs=require('node:fs');let writable;try{fs.writeFileSync('/opt/task15','x');writable=true}catch{writable=false}const status=fs.readFileSync('/proc/self/status','utf8'); console.log(JSON.stringify({uid:process.getuid(),writable,cap:/CapEff:\\s*(\\S+)/.exec(status)[1],priv:/NoNewPrivs:\\s*(\\d+)/.exec(status)[1]}));`,
    );
    expect(outcome).toEqual({ uid: 1000, writable: false, cap: "0000000000000000", priv: "1" });
  });

  it("Stop during a partial real boot body exits promptly without a model request", async () => {
    const home = mkdtempSync("/tmp/ld-t15-stop-");
    const brains = manager(home);
    let started!: () => void;
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      expect(req.url).toBe("/v1/boot");
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"sessionId":');
      started();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(TOOL_PORT, "127.0.0.1", resolve);
    });
    let cell: BrainCell | undefined;
    const taskId = ulid();
    try {
      cell = await brains.open({
        initialModelAdmission: "paused",
        sessionId: taskId,
        secrets: ["fixture"],
        pricing: PRICING,
        budgetUSD: 5,
      });
      await openFixtureBrainGate(client, cell, taskId);
      await brains.start(cell);
      await Promise.race([
        seen,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("boot never arrived")), 10000).unref(),
        ),
      ]);
      const startedAt = Date.now();
      await command("kill", "--signal", "TERM", cell.names.brain);
      expect(await brains.exited(cell, AbortSignal.timeout(5000))).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(await command("logs", cell.names.brain)).toBe("");
    } finally {
      await cleanupFixture([
        async () => {
          if (cell) await brains.close(cell);
        },
        () => shutdown(server),
        () => noOwnedResources(home),
      ]);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("retains exact ownership and port reservation when real resource deletion is uncertain", async () => {
    const home = mkdtempSync("/tmp/ld-t15-cleanup-");
    let fail = false;
    const request = <T>(r: DockerRequest): Promise<T> => {
      if (fail && r.method === "DELETE" && r.path.startsWith("/containers/"))
        return Promise.reject(new DockerError(0, "owned fixture loses delete response", r.path));
      return docker.request<T>(r);
    };
    const brains = manager(home, request);
    let cell: BrainCell | undefined;
    const taskId = ulid();
    try {
      cell = await brains.open({
        initialModelAdmission: "paused",
        sessionId: taskId,
        secrets: ["fixture"],
        pricing: PRICING,
        budgetUSD: 5,
      });
      fail = true;
      await expect(brains.close(cell)).rejects.toBeInstanceOf(BrainCleanupError);
      expect(brains.reservedPorts()).toEqual([KEYD_PORT]);
      expect(await client.cell(cell.id)).toBeUndefined();
      await expect(brains.start(cell)).rejects.toThrow("current state");
      await expect(
        brains.open({
          initialModelAdmission: "paused",
          sessionId: ulid(),
          secrets: ["fixture"],
          pricing: PRICING,
        }),
      ).rejects.toThrow("no free");
      const info = JSON.parse(await command("inspect", cell.names.gate))[0];
      expect(info.Config.Labels["localdot.home"]).toBe(homeLabel(home));
      expect(info.Config.Labels["localdot.brain"]).toBe(cell.id);
    } finally {
      fail = false;
      await cleanupFixture([
        async () => {
          if (cell) await brains.close(cell);
        },
        () => noOwnedResources(home),
      ]);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
