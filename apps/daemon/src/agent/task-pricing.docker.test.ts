import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { DEFAULT_AGENT_LIMITS, sealSecret, type TaskPricing } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { DockerClient, type DockerRequest } from "../cells/docker.ts";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd } from "../keyd/testing/keyd-process.ts";
import { type BrainCell, BrainCells, homeLabel } from "./brain-cell.ts";
import { toolHarness } from "./testing/harness.ts";
import { openFixtureBrainGate } from "./testing/model-admission.ts";

const enabled =
  process.env.LOCALDOT_DOCKER_TESTS === "1" && process.env.LOCALDOT_TASK15_TESTS === "1";
const TOOL_PORT = 4792;
const KEYD_PORT = 4793;
const CANARY = "task15-local-canary-never-real";
const INITIAL_BUDGET = 5;
const PRICING: TaskPricing = {
  v: 1,
  routes: [
    {
      route: "fixture",
      models: [
        {
          id: "fixture-priced",
          inputUSDPerMTok: 10000,
          outputUSDPerMTok: 10000,
          maxOutputTokens: 200,
        },
      ],
    },
  ],
};
const binding = {
  id: "fixture",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: "https://provider.example.test/v1",
} as const;
const execute = promisify(execFile);

// This bounded ledger worker intentionally replaces only the owned fixture brain's entrypoint.
// The standard bundled entry/model loop is exercised in brain-cell.docker.test.ts. Here the
// short real-image request keeps keyd's conservative reservation below the initial $5 ceiling.
const WORKER = `
import http from 'node:http';
const pending = new Set();
const deadline = setTimeout(() => { for (const req of pending) req.destroy(); process.exitCode = 2; }, 10000);
function request(url, {method='GET', headers={}, body}={}) {
  return new Promise((resolve,reject) => {
    const req = http.request(url, {method,headers}, res => {
      const chunks=[];let size=0;
      res.on('data', chunk => {size+=chunk.length;if(size>65536)req.destroy(new Error('reply limit'));else chunks.push(chunk);});
      res.once('error',reject);
      res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    pending.add(req);req.once('close',()=>pending.delete(req));req.once('error',reject);
    req.setTimeout(5000,()=>req.destroy(new Error('fixture deadline')));req.end(body);
  });
}
try {
  const tool = process.env.LOCALDOT_TOOL_URL;
  const refused = await request(tool+'/v1/boot');
  const bootReply = await request(tool+'/v1/boot',{headers:{authorization:'Bearer '+process.env.LOCALDOT_TOOL_TOKEN}});
  if(bootReply.status!==200)throw new Error('boot refused');
  const boot=JSON.parse(bootReply.body), model=boot.models.main;
  const proxy=new URL(boot.proxy.url);
  const call=(path,headers,body) => new Promise((resolve,reject)=>{
    const req=http.request({host:proxy.hostname,port:proxy.port,path,method:body?'POST':'GET',headers},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy(new Error('reply limit'));else chunks.push(chunk)});
      res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    pending.add(req);req.once('close',()=>pending.delete(req));req.once('error',reject);
    req.setTimeout(5000,()=>req.destroy(new Error('fixture deadline')));req.end(body);
  });
  const proxyRefused=await call('http://keyd.ldot/health',{});
  const body=JSON.stringify({model:model.model,messages:[{role:'user',content:boot.task+' '+ 'x'.repeat(580)}],max_tokens:200,stream:true});
  const response=await call('http://llm.ldot/'+model.route+'/chat/completions',{
    'proxy-authorization':'Basic '+Buffer.from('brain:'+boot.proxy.token).toString('base64'),
    authorization:'Bearer '+model.surrogate,'content-type':'application/json','content-length':Buffer.byteLength(body)
  },body);
  console.log(JSON.stringify({unauthorizedBoot:refused.status,authorizedBoot:bootReply.status,unauthorizedProxy:proxyRefused.status,bootSessionId:boot.sessionId,requestBytes:Buffer.byteLength(body),...response}));
} catch { console.error('owned pricing worker failed');process.exitCode=2; }
finally {clearTimeout(deadline);for(const req of pending)req.destroy();}
`;

interface WorkerReply {
  unauthorizedBoot: number;
  authorizedBoot: number;
  unauthorizedProxy: number;
  bootSessionId: string;
  requestBytes: number;
  status: number;
  body: string;
}
interface AuditLine {
  cell?: string;
  kind: string;
  route?: string;
  model?: string;
  status?: number;
  reason?: string;
  costMicroUSD?: number;
  usage?: string;
  swapped?: boolean;
}
async function attemptAll(steps: (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "owned pricing fixture cleanup failed");
}

async function shutdown(server: ReturnType<typeof serve>): Promise<void> {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe.skipIf(!enabled)("durable task pricing through real brain-image replacements", () => {
  it("keeps $4 spent, immutable prices and a raised $8 ceiling across brain and keyd replacements", async () => {
    const brainImage = process.env.LOCALDOT_TASK15_BRAIN_IMAGE,
      gateImage = process.env.LOCALDOT_TASK15_GATE_IMAGE;
    if (!brainImage || !gateImage || !process.env.LOCALDOT_KEYD_BIN)
      throw new Error(
        "Task15 pricing needs explicit reviewed images and its loopback acceptance keyd binary",
      );
    const h = toolHarness();
    const keydHome = mkdtempSync("/tmp/ld-t15-price-");
    const prefix = `task15-price-${randomBytes(6).toString("hex")}-`;
    const docker = new DockerClient();
    const owned = new Set<BrainCell>();
    let keyd: KeydProcess | undefined;
    let server: ReturnType<typeof serve> | undefined;
    let client: KeydClient | undefined;
    let brains: BrainCells | undefined;
    let creates = 0;
    const callDocker = async (...args: string[]) =>
      (await execute("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const audit = () =>
      readFileSync(join(keydHome, "keyd", "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditLine);
    const noOwnedResources = async () => {
      const filters = JSON.stringify({ label: [`localdot.home=${homeLabel(h.home)}`] });
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
    };
    const seal = async () => {
      if (!client) throw new Error("fixture client is absent");
      await client.putSecret(
        binding,
        await sealSecret((await client.status()).sealKey, binding, CANARY),
      );
    };
    const close = async (cell: BrainCell) => {
      await brains?.close(cell);
      owned.delete(cell);
    };
    try {
      keyd = await startKeyd({ home: keydHome, ports: { from: KEYD_PORT, to: KEYD_PORT } });
      client = new KeydClient(keyd.socketPath);
      await seal();
      const request = <T>(request: DockerRequest): Promise<T> => {
        if (request.method === "POST" && request.path === "/containers/create") {
          const body = request.body as { Image?: string; Labels?: Record<string, string> };
          const labels = body.Labels;
          if (labels?.["localdot.role"] === "brain") {
            const id = labels["localdot.brain"];
            if (
              labels["localdot.home"] !== homeLabel(h.home) ||
              labels["localdot.session"] !== h.session.id ||
              body.Image !== brainImage ||
              request.query?.name !== `${prefix}brain-${id}`
            )
              throw new Error("pricing worker override refused a foreign create");
            creates++;
            return docker.request<T>({
              ...request,
              body: { ...body, Entrypoint: ["node"], Cmd: ["--input-type=module", "-e", WORKER] },
            });
          }
        }
        return docker.request<T>(request);
      };
      brains = new BrainCells({
        docker: { request },
        keyd: client,
        images: { brain: brainImage, gate: gateImage },
        home: h.home,
        range: { from: KEYD_PORT, to: KEYD_PORT },
        desktopPorts: () => [],
        namePrefix: prefix,
        toolPort: TOOL_PORT,
        pollMs: 100,
      });
      server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: TOOL_PORT });
      await new Promise<void>((resolve, reject) => {
        if (server?.listening) resolve();
        else {
          server?.once("listening", resolve);
          server?.once("error", reject);
        }
      });
      const open = async (spent: number, limit: number) => {
        if (!brains || !client) throw new Error("fixture not ready");
        const cell = await brains.open({
          initialModelAdmission: "paused",
          sessionId: h.session.id,
          secrets: ["fixture"],
          pricing: PRICING,
          budgetUSD: INITIAL_BUDGET,
        });
        owned.add(cell);
        const generation = h.session.beginBrain();
        h.session.publishBrain(generation, {
          toolToken: cell.toolToken,
          brainCellId: cell.id,
          boot: {
            sessionId: h.session.id,
            task: "charge-four",
            models: {
              main: {
                route: "fixture",
                client: "openai-compatible",
                model: "fixture-priced",
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
          },
        });
        expect((await client.cell(cell.id))?.task).toEqual({
          id: h.session.id,
          spentUSD: spent,
          limitUSD: limit,
        });
        return cell;
      };
      const run = async (
        cell: BrainCell,
        task: "charge-four" | "charge-two",
      ): Promise<WorkerReply> => {
        if (!brains || !h.session.boot) throw new Error("fixture not ready");
        h.session.boot.task = task;
        if (!client) throw new Error("fixture client is absent");
        await openFixtureBrainGate(client, cell, h.session.id);
        await brains.start(cell);
        expect(await brains.exited(cell, AbortSignal.timeout(20000))).toBe(0);
        const inspect = (
          JSON.parse(await callDocker("inspect", cell.names.brain)) as {
            Id: string;
            Config: { Labels: Record<string, string> };
          }[]
        )[0];
        if (
          !inspect ||
          inspect.Config.Labels["localdot.home"] !== homeLabel(h.home) ||
          inspect.Config.Labels["localdot.brain"] !== cell.id
        )
          throw new Error("pricing worker identity changed");
        const logs = await callDocker("logs", inspect.Id);
        expect(logs).not.toContain(CANARY);
        expect(logs).not.toContain(cell.proxyToken);
        expect(logs).not.toContain(cell.toolToken);
        const reply = JSON.parse(logs) as WorkerReply;
        expect(reply).toMatchObject({
          unauthorizedBoot: 401,
          authorizedBoot: 200,
          unauthorizedProxy: 407,
          bootSessionId: h.session.id,
        });
        // Admission must require more than the $1/$2 remaining in refused phases, yet fit $5.
        expect(Math.ceil(reply.requestBytes / 3) * 0.01).toBeGreaterThan(2);
        expect(Math.ceil(reply.requestBytes / 3) * 0.01 + 2).toBeLessThanOrEqual(5);
        return reply;
      };
      const expectCharge = (reply: WorkerReply, input: number) => {
        expect(reply.status).toBe(200);
        const data = reply.body.split("\n").find((line) => line.startsWith("data: {"));
        if (!data) throw new Error("provider did not report SSE usage");
        expect(JSON.parse(data.slice(6)).usage).toEqual({
          prompt_tokens: input,
          completion_tokens: 0,
          total_tokens: input,
        });
        expect(reply.body).toContain("data: [DONE]");
      };
      const expectRefused = (reply: WorkerReply, spent: number, limit: number) => {
        expect(reply.status).toBe(402);
        expect(JSON.parse(reply.body)).toMatchObject({
          error: { type: "budget_exceeded", scope: "task", limitUSD: limit, spentUSD: spent },
        });
      };
      const first = await open(0, 5);
      expectCharge(await run(first, "charge-four"), 400);
      expect((await client.cell(first.id))?.task).toEqual({
        id: h.session.id,
        spentUSD: 4,
        limitUSD: 5,
      });
      await close(first);
      expect(await client.cell(first.id)).toBeUndefined();

      const second = await open(4, 5);
      expect(second.id).not.toBe(first.id);
      expect(second.proxyToken).not.toBe(first.proxyToken);
      // A global catalog publication cannot reprice or revoke this immutable task attachment.
      await client.setRouteModels("fixture", [
        { id: "fixture-priced", inputUSDPerMTok: 1, outputUSDPerMTok: 1, maxOutputTokens: 200 },
      ]);
      expectRefused(await run(second, "charge-two"), 4, 5);
      expect((await client.cell(second.id))?.task).toEqual({
        id: h.session.id,
        spentUSD: 4,
        limitUSD: 5,
      });
      await client.beginTask(second.id, h.session.id, 8);
      expect((await client.cell(second.id))?.task?.limitUSD).toBe(8);
      await close(second);

      const oldBoot = keyd.bootId;
      await keyd.stop();
      keyd = undefined;
      keyd = await startKeyd({ home: keydHome, ports: { from: KEYD_PORT, to: KEYD_PORT } });
      expect(keyd.bootId).not.toBe(oldBoot);
      await seal(); // The fixture vault is memory-only; the binding identity is unchanged.
      const third = await open(4, 8); // Same original $5 argument must not erase the explicit raise.
      expect(third.id).not.toBe(second.id);
      expect((await client.routeModels("fixture"))[0]?.inputUSDPerMTok).toBe(1);
      const repriced = structuredClone(PRICING);
      const model = repriced.routes[0]?.models[0];
      if (!model) throw new Error("pricing fixture model is absent");
      model.inputUSDPerMTok = 2;
      await expect(
        client.beginPricedTask(third.id, h.session.id, repriced, 5),
      ).rejects.toMatchObject({ status: 409 });
      expectCharge(await run(third, "charge-two"), 200);
      expect((await client.cell(third.id))?.task).toEqual({
        id: h.session.id,
        spentUSD: 6,
        limitUSD: 8,
      });
      await close(third);
      const fourth = await open(6, 8);
      expectRefused(await run(fourth, "charge-two"), 6, 8);
      expect((await client.cell(fourth.id))?.task).toEqual({
        id: h.session.id,
        spentUSD: 6,
        limitUSD: 8,
      });
      expect((await client.budget()).day.spentUSD).toBe(6);
      const requests = audit().filter(
        (line) => line.kind === "request" && line.route === "fixture",
      );
      expect(requests.filter((line) => line.status === 200)).toMatchObject([
        {
          cell: first.id,
          model: "fixture-priced",
          costMicroUSD: 4000000,
          usage: "reported",
          swapped: true,
        },
        {
          cell: third.id,
          model: "fixture-priced",
          costMicroUSD: 2000000,
          usage: "reported",
          swapped: true,
        },
      ]);
      expect(requests.filter((line) => line.status === 402)).toMatchObject([
        { cell: second.id, reason: "budget-task" },
        { cell: fourth.id, reason: "budget-task" },
      ]);
      expect(creates).toBe(4);
    } finally {
      await attemptAll([
        () => h.session.stop(),
        ...[...owned].map((cell) => () => close(cell)),
        async () => {
          if (brains) await brains.sweep();
        },
        async () => {
          if (server) await shutdown(server);
        },
        async () => {
          if (keyd) await keyd.stop();
          keyd = undefined;
        },
        noOwnedResources,
        () => h.eventLog.close(),
      ]);
      // Any cleanup failure above keeps both owned homes available for diagnosis/recovery.
      rmSync(h.home, { recursive: true, force: true });
      rmSync(keydHome, { recursive: true, force: true });
    }
  }, 120000);
});
