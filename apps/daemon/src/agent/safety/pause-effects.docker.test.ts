import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { DEFAULT_AGENT_LIMITS, sealSecret, type TaskPricing, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { DockerClient, type DockerRequest } from "../../cells/docker.ts";
import { KeydClient } from "../../keyd/client.ts";
import { type KeydProcess, startKeyd } from "../../keyd/testing/keyd-process.ts";
import { type BrainCell, BrainCells, homeLabel } from "../brain-cell.ts";
import { toolHarness } from "../testing/harness.ts";
import { SafetyController } from "./controller.ts";
import { SafetyIntentStore } from "./store.ts";

const enabled =
  process.env.LOCALDOT_DOCKER_TESTS === "1" && process.env.LOCALDOT_SAFETY_TASK3_TESTS === "1";
const TOOL_PORT = 4794,
  KEYD_PORT = 4793;
const CANARY = "task15-local-canary-never-real";
const binding = {
  id: "fixture",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: "https://provider.example.test/v1",
} as const;
const PRICING: TaskPricing = {
  v: 1,
  routes: [
    {
      route: "fixture",
      models: [
        {
          id: "fixture-safety-pause",
          inputUSDPerMTok: 1,
          outputUSDPerMTok: 1,
          maxOutputTokens: 20,
        },
      ],
    },
  ],
};
const execute = promisify(execFile);

// This owned real-image probe exercises the production keyd gateway, tool API and lifecycle.
// It deliberately attempts an extra provider call while paused; the host loop suite separately
// proves the normal model loop waits. Desktop work is one bounded synthetic physical sink.
const WORKER = `
import http from 'node:http';
const pending=new Set();
const deadline=setTimeout(()=>{for(const req of pending)req.destroy(new Error('owned deadline'));process.exitCode=2;},25000);
function request(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{
 const parsed=typeof url==='string'?new URL(url):null;const options=parsed?{hostname:parsed.hostname,port:parsed.port,path:parsed.pathname+parsed.search}:url;const req=http.request({...options,method,headers},res=>{let size=0;const parts=[];res.on('data',b=>{size+=b.length;if(size>65536)req.destroy(new Error('reply limit'));else parts.push(b);});res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString('utf8')}));});
 pending.add(req);req.once('close',()=>pending.delete(req));req.once('error',reject);req.setTimeout(20000,()=>req.destroy(new Error('request deadline')));req.end(body);
});}
let stage='boot';
try{
 console.log(JSON.stringify({phase:'started'}));const tool=process.env.LOCALDOT_TOOL_URL, auth={authorization:'Bearer '+process.env.LOCALDOT_TOOL_TOKEN,'content-type':'application/json'};
 const denied=await request(tool+'/v1/boot');console.log(JSON.stringify({phase:'unauthorized-boot',status:denied.status}));
 const bootReply=await request(tool+'/v1/boot',{headers:auth});console.log(JSON.stringify({phase:'authorized-boot',status:bootReply.status}));if(bootReply.status!==200)throw new Error('owned boot refused');const boot=JSON.parse(bootReply.body);
 const proxy=new URL(boot.proxy.url),m=boot.models.main;
 const model=()=>{const body=JSON.stringify({model:m.model,messages:[{role:'user',content:'bounded safety probe'}],max_tokens:20,stream:true});return request({hostname:proxy.hostname,port:proxy.port,path:'http://llm.ldot/'+m.route+'/chat/completions'}, {method:'POST',headers:{'proxy-authorization':'Basic '+Buffer.from('brain:'+boot.proxy.token).toString('base64'),authorization:'Bearer '+m.surrogate,'content-type':'application/json','content-length':Buffer.byteLength(body)},body});};
 const call=(name,input,id)=>request(tool+'/v1/tools/'+name,{method:'POST',headers:auth,body:JSON.stringify({callId:id,input})});
 stage='initial-model';const first=await model();console.log(JSON.stringify({phase:'first-model',status:first.status}));if(first.status!==200)throw new Error('first provider refused');
 stage='finite-shell';const shell=call('shell',{command:'printf bounded-fixture'},'docker-shell');
 const queued=call('files',{op:'write',path:'queued-before-pause.txt',content:'must never be written'},'docker-queued');
 const done=await shell,refused=await queued;
 const held=await model();const control=await request(tool+'/v1/control?waitMs=0',{headers:auth});
 console.log(JSON.stringify({phase:'held',unauthorizedBoot:denied.status,first:first.status,shell:JSON.parse(done.body).ok,queued:JSON.parse(refused.body),held:held.status,heldBody:JSON.parse(held.body),control:JSON.parse(control.body)}));
 let state=JSON.parse(control.body);while(state.pause){const next=await request(tool+'/v1/control?after='+state.revision+'&waitMs=1000',{headers:auth});if(next.status!==200)throw new Error('control refused');state=JSON.parse(next.body);}
 const second=await model();const file=await call('files',{op:'write',path:'resumed-only.txt',content:'explicit resume'},'docker-resumed');
 console.log(JSON.stringify({phase:'resumed',second:second.status,file:JSON.parse(file.body).ok,control:state}));
}catch{console.log(JSON.stringify({phase:'failed',stage}));process.exitCode=2;}finally{clearTimeout(deadline);for(const req of pending)req.destroy();}
`;

async function attemptAll(steps: (() => void | Promise<void>)[]) {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length) throw new AggregateError(failures, "owned safety cleanup unconfirmed");
}
async function shutdown(server: ReturnType<typeof serve>) {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

describe.skipIf(!enabled)(
  "API Pause at a settled step through owned keyd and a real brain image",
  () => {
    it("drains a finite shell, refuses queued/model effects, and resumes the same priced owner explicitly", async () => {
      const brainImage = process.env.LOCALDOT_SAFETY_BRAIN_IMAGE,
        gateImage = process.env.LOCALDOT_SAFETY_GATE_IMAGE;
      if (!brainImage || !gateImage || !process.env.LOCALDOT_KEYD_BIN)
        throw new Error(
          "explicit cached images and current source-bound acceptance keyd are required",
        );
      const h = toolHarness(),
        keydHome = mkdtempSync("/tmp/ld-m5-t3-"),
        prefix = `m5-t3-${randomBytes(6).toString("hex")}-`,
        docker = new DockerClient();
      const owned = new Set<BrainCell>();
      let keyd: KeydProcess | undefined,
        client: KeydClient | undefined,
        brains: BrainCells | undefined,
        server: ReturnType<typeof serve> | undefined,
        cell: BrainCell | undefined;
      let release!: () => void, started!: () => void;
      const active = new Promise<void>((r) => (started = r)),
        finish = new Promise<void>((r) => (release = r));
      let shellCount = 0,
        writes = 0,
        creates = 0;
      const desktop = h.tools.desktop(h.session.cellId);
      if (!desktop) throw new Error("owned desktop sink is absent");
      const original = h.tools.desktop;
      const write = desktop.writeFile.bind(desktop);
      h.tools.desktop = () => ({
        ...desktop,
        shell: async (req, onChunk) => {
          shellCount++;
          started();
          await finish;
          return desktop.shell(req, onChunk);
        },
        writeFile: async (...args) => {
          writes++;
          return write(...args);
        },
      });
      const command = async (...args: string[]) =>
        (await execute("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
      const count = () => {
        try {
          return readFileSync(join(keydHome, "keyd", "safety-provider-count.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean).length;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw e;
        }
      };
      const requireClient = () => {
        if (!client) throw new Error("owned keyd client is absent");
        return client;
      };
      const requireCell = () => {
        if (!cell) throw new Error("owned brain is absent");
        return cell;
      };
      const logs = async () => (cell ? await command("logs", cell.names.brain) : "");
      const until = async <T>(work: () => Promise<T | undefined>): Promise<T> => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          const value = await work();
          if (value !== undefined) return value;
          await new Promise((r) => setTimeout(r, 30));
        }
        throw new Error("owned probe wait expired");
      };
      try {
        keyd = await startKeyd({ home: keydHome, ports: { from: KEYD_PORT, to: KEYD_PORT } });
        client = new KeydClient(keyd.socketPath);
        await client.putSecret(
          binding,
          await sealSecret((await client.status()).sealKey, binding, CANARY),
        );
        const request = <T>(req: DockerRequest): Promise<T> => {
          if (req.method === "POST" && req.path === "/containers/create") {
            const body = req.body as { Image?: string; Labels?: Record<string, string> };
            const l = body.Labels;
            if (l?.["localdot.role"] === "brain") {
              const id = l["localdot.brain"];
              if (
                l["localdot.home"] !== homeLabel(h.home) ||
                l["localdot.session"] !== h.session.id ||
                body.Image !== brainImage ||
                req.query?.name !== `${prefix}brain-${id}`
              )
                throw new Error("owned probe refused foreign create");
              creates++;
              return docker.request<T>({
                ...req,
                body: { ...body, Entrypoint: ["node"], Cmd: ["--input-type=module", "-e", WORKER] },
              });
            }
          }
          return docker.request<T>(req);
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
          pollMs: 50,
        });
        server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: TOOL_PORT });
        await new Promise<void>((resolve, reject) => {
          if (server?.listening) resolve();
          else {
            server?.once("listening", resolve);
            server?.once("error", reject);
          }
        });
        cell = await brains.open({
          initialModelAdmission: "paused",
          sessionId: h.session.id,
          secrets: ["fixture"],
          pricing: PRICING,
          budgetUSD: 1,
        });
        owned.add(cell);
        const surrogate = cell.surrogates.fixture;
        if (!surrogate) throw new Error("owned surrogate is absent");
        const generation = h.session.beginBrain();
        h.session.publishBrain(generation, {
          toolToken: cell.toolToken,
          brainCellId: cell.id,
          boot: {
            sessionId: h.session.id,
            task: "bounded safety probe",
            models: {
              main: {
                route: "fixture",
                client: "openai-compatible",
                model: "fixture-safety-pause",
                surrogate,
                computer: "none",
                coords: "pixels",
                vision: false,
                reasoning: false,
                contextTokens: 200000,
                maxOutputTokens: 20,
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
        const fresh = await client.modelAdmission(cell.id);
        expect(fresh).toMatchObject({
          taskId: h.session.id,
          paused: true,
          active: 0,
          retired: false,
        });
        await client.setModelAdmission(cell.id, {
          taskId: h.session.id,
          generationId: fresh.generationId,
          expectedEpoch: fresh.epoch,
          state: "open",
        });
        const controller = new SafetyController(h.session, {
          owner: () => (cell ? { cellId: cell.id, taskId: h.session.id } : undefined),
          ready: () => {},
          mode: "api",
          modelAdmission: (id) => requireClient().modelAdmission(id),
          setModelAdmission: (id, v) => requireClient().setModelAdmission(id, v),
          persist: (pause) =>
            new SafetyIntentStore(h.home).write(
              h.session.id,
              h.session.cellId,
              h.session.autonomy,
              pause,
            ),
          sleep: (ms, signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, ms);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        });
        await brains.start(cell);
        await until(async () => {
          if (shellCount === 1) return true;
          const v = JSON.parse(await command("inspect", requireCell().names.brain))[0];
          if (!v?.State?.Running) throw new Error("owned worker exited before shell");
          return undefined;
        });
        await active;
        expect(count()).toBe(1);
        const before = await client.cell(cell.id);
        const beforeTask = before?.task;
        if (!beforeTask) throw new Error("owned priced task is absent");
        expect(before?.task?.spentUSD).toBe(0.000005);
        expect(before?.task?.limitUSD).toBe(1);
        const requested = controller.request(ulid());
        expect(h.session.safetyPause?.phase).toBe("pausing");
        await until(async () => {
          const v = await requireClient().modelAdmission(requireCell().id);
          return v.paused ? v : undefined;
        });
        expect(shellCount).toBe(1);
        expect(writes).toBe(0);
        expect(h.session.safetyPause?.atStepBoundary).toBe(false);
        release();
        await controller.settled();
        expect(h.session.safetyPause).toMatchObject({
          phase: "paused",
          atStepBoundary: true,
          resumeAvailable: true,
        });
        const held = await until(async () => {
          const line = (await logs()).split("\n").find((l) => l.includes('"phase":"held"'));
          return line ? JSON.parse(line) : undefined;
        });
        expect(held).toMatchObject({
          unauthorizedBoot: 401,
          first: 200,
          shell: true,
          queued: { ok: false, pause: true },
          held: 409,
          heldBody: { code: "task_paused" },
          control: { pause: { phase: "paused", resumeAvailable: true } },
        });
        expect(count()).toBe(1);
        expect(writes).toBe(0);
        expect(await client.cell(cell.id)).toMatchObject({ task: beforeTask });
        h.session.post("steer", "durable steer cannot resume");
        h.session.post("followup", "another retained follow-up");
        await client.beginTask(cell.id, h.session.id, 1);
        await new Promise((r) => setTimeout(r, 100));
        expect(count()).toBe(1);
        expect((await client.modelAdmission(cell.id)).paused).toBe(true);
        expect(h.session.safetyPause?.phase).toBe("paused");
        await expect(
          controller.resume(requested.requestId, requested.revision + 1),
        ).rejects.toThrow();
        expect(count()).toBe(1);
        await controller.resume(requested.requestId, requested.revision);
        expect(await brains.exited(cell, AbortSignal.timeout(15000))).toBe(0);
        const finalLogs = await logs();
        for (const secret of [CANARY, cell.proxyToken, cell.toolToken])
          expect(finalLogs).not.toContain(secret);
        const resumedLine = finalLogs.split("\n").find((l) => l.includes('"phase":"resumed"'));
        if (!resumedLine) throw new Error("owned Resume receipt is absent");
        const resumed = JSON.parse(resumedLine);
        expect(resumed).toMatchObject({
          second: 200,
          file: true,
          control: { revision: expect.any(Number) },
        });
        expect(resumed.control.pause).toBeUndefined();
        expect(count()).toBe(2);
        expect(shellCount).toBe(1);
        expect(writes).toBe(1);
        expect(h.desktop.files.has("queued-before-pause.txt")).toBe(false);
        expect(h.desktop.files.get("resumed-only.txt")).toBe("explicit resume");
        expect((await client.cell(cell.id))?.task).toEqual({ ...beforeTask, spentUSD: 0.00001 });
        expect(creates).toBe(1);
        if (process.env.LOCALDOT_SAFETY_TASK3_REPORT)
          writeFileSync(
            process.env.LOCALDOT_SAFETY_TASK3_REPORT,
            JSON.stringify(
              {
                scenario:
                  "actual keyd gateway and owned real-image probe; synthetic finite desktop sink",
                providerCounts: { beforePause: 1, whilePaused: 1, afterResume: 2 },
                shellStarts: shellCount,
                fileWrites: writes,
                queuedFile: false,
                creates,
                taskPricing: PRICING,
                spentBefore: beforeTask.spentUSD,
                spentAfter: 0.00001,
                limitUSD: 1,
                held,
                resumed,
              },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
      } catch (error) {
        if (process.env.LOCALDOT_SAFETY_TASK3_REPORT) {
          let text = await logs().catch(() => "owned log unavailable");
          for (const secret of [CANARY, cell?.proxyToken, cell?.toolToken].filter(
            (v): v is string => !!v,
          ))
            text = text.replaceAll(secret, "[redacted]");
          writeFileSync(
            process.env.LOCALDOT_SAFETY_TASK3_REPORT + ".failure.json",
            JSON.stringify(
              {
                providerCount: count(),
                shellCount,
                writes,
                creates,
                logs: text,
                worker: cell
                  ? JSON.parse(await command("inspect", cell.names.brain))[0]?.State
                  : undefined,
              },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
        }
        throw error;
      } finally {
        release?.();
        h.tools.desktop = original;
        await attemptAll([
          () => {
            h.session.stop();
          },
          ...Array.from(owned, (c) => async () => {
            await brains?.close(c);
            owned.delete(c);
          }),
          async () => {
            const filters = JSON.stringify({ label: [`localdot.home=${homeLabel(h.home)}`] });
            expect(
              await docker.request<unknown[]>({
                method: "GET",
                path: "/containers/json",
                query: { all: "true", filters },
              }),
            ).toEqual([]);
            expect(
              await docker.request<unknown[]>({
                method: "GET",
                path: "/networks",
                query: { filters },
              }),
            ).toEqual([]);
          },
          async () => {
            if (server) await shutdown(server);
          },
          async () => {
            await keyd?.stop();
          },
        ]);
        h.close();
        rmSync(keydHome, { recursive: true, force: true });
      }
    });
  },
);
