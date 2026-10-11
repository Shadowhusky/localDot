import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  CAREFUL_AUTONOMY,
  ReplacementRecord,
  type SecretBinding,
  sealSecret,
  ulid,
} from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { DockerClient, DockerError } from "../../cells/docker.ts";
import { CellOrchestrator } from "../../cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "../../cells/readiness.ts";
import { TicketRegistry } from "../../cells/secrets.ts";
import { CellStore } from "../../cells/store.ts";
import { ComputerSystemState } from "../../cells/system-state.ts";
import { DesktopdTools } from "../../desktopd/tools-client.ts";
import { KillSwitch } from "../../gateway/kill-switch.ts";
import { LiveSessions } from "../../gateway/live.ts";
import { CellKeydWiring } from "../../keyd/cell-wiring.ts";
import { KeydClient } from "../../keyd/client.ts";
import { startKeyd } from "../../keyd/testing/keyd-process.ts";
import { BrainCells } from "../brain-cell.ts";
import { MemoryStore } from "../memory.ts";
import { actPolicy } from "../policy.ts";
import { redactor } from "../redact.ts";
import { AgentRunner } from "../runner.ts";
import { toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "../tools/index.ts";
import { ComputerFences } from "./fences.ts";
import { createReplacementController } from "./replacement-controller.ts";

const enabled =
  process.env.LOCALDOT_DOCKER_TESTS === "1" && process.env.LOCALDOT_SAFETY_TASK5_TESTS === "1";
const PORTS = { from: 4795, to: 4796 },
  TOKEN = "r".repeat(43),
  PREFIX = "localdot-test-safety5-";
async function until(test: () => boolean, timeout = 75000) {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error("owned replacement readiness deadline");
    await new Promise<void>((r) => setTimeout(r, 30));
  }
}
describe.skipIf(!enabled)("actual fenced replacement", () => {
  it("shell_execution_uncertain retires the exact old computer before fresh authorization", async () => {
    const desktopImage = process.env.LOCALDOT_SAFETY_DESKTOP_IMAGE,
      gateImage = process.env.LOCALDOT_SAFETY_GATE_IMAGE,
      brainImage = process.env.LOCALDOT_SAFETY_BRAIN_IMAGE;
    if (!desktopImage || !gateImage || !brainImage || !process.env.LOCALDOT_KEYD_BIN)
      throw new Error("owned cached images and keyd fixture required");
    const h = toolHarness({ autoApprove: false, autonomy: CAREFUL_AUTONOMY }),
      keydHome = mkdtempSync("/tmp/ld-safety5-keyd-"),
      docker = new DockerClient(),
      store = new CellStore(h.home, PORTS),
      fences = new ComputerFences(h.home),
      live = new LiveSessions(),
      tickets = new TicketRegistry();
    let keyd: Awaited<ReturnType<typeof startKeyd>> | undefined,
      cells: CellOrchestrator | undefined,
      runner: AgentRunner | undefined,
      tools: DesktopdTools | undefined;
    const oldCellId = h.session.cellId,
      observed: {
        commandExecuted: boolean;
        acknowledgementLost: boolean;
        uncertaintyReason?: string;
        oldRetired: boolean;
        freshReady: boolean;
      } = {
        commandExecuted: false,
        acknowledgementLost: false,
        oldRetired: false,
        freshReady: false,
      };
    const ownedIds = new Set([oldCellId]);
    const errors: unknown[] = [];
    const transport: Record<string, unknown> = {};
    let report: Record<string, unknown> | undefined;
    try {
      keyd = await startKeyd({ home: keydHome, ports: PORTS });
      const client = new KeydClient(keyd.socketPath),
        wiring = new CellKeydWiring({ keyd: client, docker });
      const binding: SecretBinding = {
        id: "fixture",
        kind: "http",
        hosts: ["provider.example.test"],
        header: "Authorization",
        format: "bearer",
      };
      await client.putSecret(
        binding,
        await sealSecret((await client.status()).sealKey, binding, "task5-local-canary-never-real"),
      );
      cells = new CellOrchestrator({
        docker,
        store,
        keyd: wiring,
        images: { desktop: desktopImage, gate: gateImage },
        permanentFence: (id) => (fences.record(id) ? { revision: 1 } : fences.isFenced(id)),
        probeDesktopd,
        probeStream,
        namePrefix: PREFIX,
        readyTimeoutMs: 60000,
        watchEveryMs: 60000,
      });
      const c = cells;
      await c.create({ id: oldCellId, scale: 1 });
      await until(
        () => c.get(oldCellId)?.state === "ready" || c.get(oldCellId)?.state === "failed",
      );
      expect(c.get(oldCellId)?.state).toBe("ready");
      const old = store.get(oldCellId),
        endpoint = c.endpoints(oldCellId);
      if (!old || !endpoint) throw new Error("owned old computer unavailable");
      const oldKeyd = await client.cell(oldCellId);
      expect(oldKeyd).toBeDefined();
      const ticket = tickets.issue(oldCellId);
      const kill = new KillSwitch({ live, keyd: wiring, cells: c, settleMs: 200 }),
        brains = new BrainCells({
          docker,
          keyd: client,
          images: { brain: brainImage, gate: gateImage },
          home: h.home,
          range: PORTS,
          desktopPorts: () => c.reservedKeydPorts(),
          namePrefix: PREFIX,
          toolPort: 4794,
          pollMs: 50,
        });
      runner = new AgentRunner({
        home: h.home,
        fences,
        eventLog: h.eventLog,
        live,
        cell: (id) => c.get(id),
        cellBusy: (id) => kill.isBusy(id),
        brains,
        keyd: client,
        settings: () => ({ main: { provider: "chatgpt", model: "gpt-6-astra" } }),
        catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-04T00:00:00Z"),
        memory: new MemoryStore(h.home),
        transcripts: h.transcripts,
        installSkills: async () => [],
        waitForUploads: async () => {},
        stopSession: (id) => kill.stopSession(id),
      });
      const r = runner;
      live.start(
        oldCellId,
        h.session.id,
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      );
      // Real desktopd executes and acknowledges a bounded command. This transport loses that ACK,
      // so the production client and shell tool must take their typed uncertainty/containment path.
      tools = new DesktopdTools(endpoint.desktopd, async (input, init) => {
        transport.stage = "request";
        const response = await fetch(input, init);
        transport.stage = "response";
        transport.status = response.status;
        if (!String(input).endsWith("/shell")) return response;
        const text = await response.text(),
          rows = text
            .trim()
            .split("\n")
            .map(
              (line) => JSON.parse(line) as { done?: boolean; exitCode?: number; chunk?: string },
            );
        transport.stage = "decoded";
        transport.rowKeys = rows.map((row) => Object.keys(row));
        transport.exits = rows.filter((row) => row.done).map((row) => row.exitCode);
        observed.commandExecuted =
          rows.some((row) => row.done && row.exitCode === 0) &&
          rows.some((row) => row.chunk?.includes("owned-task5-effect"));
        expect(observed.commandExecuted, JSON.stringify(transport)).toBe(true);
        observed.acknowledgementLost = true;
        return new Response(
          new ReadableStream({
            start(control) {
              control.error(new Error("owned lost acknowledgement"));
            },
          }),
          { status: response.status },
        );
      });
      h.tools.desktop = (id) => (id === oldCellId ? tools : undefined);
      h.tools.stopForUncertainty = async (session, reason) => {
        observed.uncertaintyReason = reason;
        await r.contain(session, reason);
      };
      const pending = dispatchTool(
        { tools: h.tools, policy: actPolicy },
        h.session,
        "shell",
        "owned-shell",
        {
          command:
            "mkdir -p Downloads; printf 'owned-task5-effect\\n' > Downloads/safety5-recovery.txt; cat Downloads/safety5-recovery.txt",
          timeout_sec: 10,
        },
        redactor([]),
      );
      await until(() => !!h.session.pendingApproval, 5000);
      const card = h.session.pendingApproval;
      if (!card) throw new Error("shell approval missing");
      h.session.answerApproval({
        approvalId: card.approvalId,
        generation: card.generation,
        revision: card.revision,
        decision: "approve",
      });
      expect((await pending).result).toMatchObject({ ok: false, final: true });
      expect(observed, JSON.stringify(transport)).toMatchObject({
        commandExecuted: true,
        acknowledgementLost: true,
        uncertaintyReason: "shell_execution_uncertain",
      });
      await live.settled(h.session.id);
      expect(new ComputerFences(h.home).record(oldCellId)).toMatchObject({
        sessionId: h.session.id,
        revision: 1,
        executor: "api",
      });
      const replacement = createReplacementController({
        home: h.home,
        fences,
        runner: r,
        cells: c,
        tickets,
        readyTimeoutMs: 60000,
      });
      const app = createApp({
        token: TOKEN,
        port: 4790,
        eventLog: h.eventLog,
        cells: { cells: c, tickets, replacement },
        desktop: { cells: c, tickets, vendorDir: "/private/tmp/unused-selkies" },
      });
      const request = (path: string, method = "GET", body?: unknown) =>
        app.request(`http://127.0.0.1:4790${path}`, {
          method,
          headers: {
            host: "127.0.0.1:4790",
            origin: "http://127.0.0.1:4790",
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const body = { requestId: ulid(), oldRevision: 1, home: "fresh" },
        response = await request(`/api/cells/${oldCellId}/replacement`, "POST", body);
      expect(response.status).toBe(200);
      const ready = ReplacementRecord.parse(await response.json());
      expect(ready.phase).toBe("ready");
      const newCellId = ready.newCellId;
      if (!newCellId) throw new Error("fresh identity missing");
      ownedIds.add(newCellId);
      const fresh = store.get(newCellId);
      if (!fresh) throw new Error("fresh record missing");
      for (const [kind, name] of [
        ["containers", old.docker.desktop],
        ["containers", old.docker.gate],
        ["networks", old.docker.internalNetwork],
        ["networks", old.docker.egressNetwork],
        ["containers", old.ownership?.desktop],
        ["containers", old.ownership?.gate],
        ["networks", old.ownership?.internalNetwork],
        ["networks", old.ownership?.egressNetwork],
      ] as const) {
        if (!name) throw new Error("captured old identity missing");
        let absent = false;
        try {
          await docker.request({
            method: "GET",
            path: `/${kind}/${encodeURIComponent(name)}${kind === "containers" ? "/json" : ""}`,
          });
        } catch (error) {
          absent = error instanceof DockerError && error.status === 404;
        }
        expect(absent).toBe(true);
      }
      expect(await client.cell(oldCellId)).toBeUndefined();
      expect(await client.cell(newCellId)).toBeDefined();
      expect(live.get(oldCellId)).toBeUndefined();
      expect(c.endpoints(oldCellId)).toBeUndefined();
      expect(tickets.hasLiveTicket(oldCellId)).toBe(false);
      observed.oldRetired = true;
      const oldHome = await docker.request<{ Labels: Record<string, string> }>({
        method: "GET",
        path: `/volumes/${old.docker.homeVolume}`,
      });
      expect(oldHome.Labels["localdot.cell"]).toBe(oldCellId);
      expect(
        await docker.request({
          method: "GET",
          path: "/containers/json",
          query: { all: "true", filters: JSON.stringify({ volume: [old.docker.homeVolume] }) },
        }),
      ).toEqual([]);
      expect(fresh.docker.homeVolume).not.toBe(old.docker.homeVolume);
      expect(fresh.tokens.desktopd).not.toBe(old.tokens.desktopd);
      expect(fresh.tokens.stream).not.toBe(old.tokens.stream);
      expect(c.get(newCellId)?.state).toBe("ready");
      observed.freshReady = true;
      const freshEndpoint = c.endpoints(newCellId);
      if (!freshEndpoint) throw new Error("fresh endpoint missing");
      const freshTools = new DesktopdTools(freshEndpoint.desktopd);
      try {
        expect((await freshTools.readFile("Downloads/safety5-recovery.txt")).content).toBe(
          "owned-task5-effect\n",
        );
      } finally {
        await freshTools.close();
      }
      await expect(r.start(oldCellId, "late old task")).rejects.toThrow("cleanup needs attention");
      await expect(c.start(oldCellId)).rejects.toThrow("fenced");
      await expect(kill.resume(oldCellId)).rejects.toThrow("fenced");
      expect((await request(`/cells/${oldCellId}/desktop/${ticket}/api/status`)).status).toBe(403);
      expect((await request(`/api/cells/${oldCellId}/stream-ticket`, "POST")).status).toBe(409);
      expect(
        ReplacementRecord.parse(
          await (await request(`/api/cells/${oldCellId}/replacement/${body.requestId}`)).json(),
        ),
      ).toEqual(ready);
      expect(
        ReplacementRecord.parse(
          await (await request(`/api/cells/${oldCellId}/replacement`, "POST", body)).json(),
        ),
      ).toEqual(ready);
      const cold = createReplacementController({
        home: h.home,
        fences: new ComputerFences(h.home),
        runner: r,
        cells: c,
        tickets,
      });
      await cold.owner.start();
      expect(await cold.owner.status(oldCellId, body.requestId)).toEqual(ready);
      report = {
        task: "M5 Task5 actual Docker shell uncertainty replacement",
        date: "2026-10-04",
        branch: "shell_execution_uncertain",
        observed,
        oldCellId,
        newCellId,
        requestId: body.requestId,
        capturedOldOwnership: old.ownership,
        oldHomeDetached: true,
        copiedHome: true,
        freshTokens: true,
        oldInputDenied: true,
        oldStreamTicketStatus: 403,
        sameRequestSameCandidate: true,
        restartSameCandidate: true,
        privateSyntheticCredentialsOnly: true,
        realAccount: "not-run",
        nativeSandbox: "unverified",
      };
    } catch (error) {
      errors.push(error);
    } finally {
      for (const close of [
        () => cells?.dispose(),
        () => h.session.stop(),
        () => live.stop(h.session.id),
      ])
        try {
          close();
        } catch (error) {
          errors.push(error);
        }
      try {
        await runner?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await tools?.close();
      } catch (error) {
        errors.push(error);
      }
      const cleanupIds = new Set(ownedIds);
      try {
        for (const record of store.list()) cleanupIds.add(record.id);
      } catch (error) {
        errors.push(error);
      }
      for (const id of cleanupIds)
        try {
          const retired = await cells?.retireReplacement(id, true);
          if (cells && (!retired?.absent || !retired.revoked))
            errors.push(new Error("owned replacement cleanup uncertain"));
        } catch (error) {
          errors.push(error);
        }
      for (const id of cleanupIds) {
        const saved = new ComputerSystemState(h.home, docker, desktopImage).records.read(id);
        if (saved)
          await docker
            .request({ method: "DELETE", path: `/images/${saved.image}` })
            .catch((error) => errors.push(error));
      }
      try {
        await keyd?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        h.closeResources();
      } catch (error) {
        errors.push(error);
      }
      // Retain both ownership homes until every independent resource owner confirms cleanup.
      if (!errors.length) {
        try {
          h.close();
          rmSync(keydHome, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "owned fixture failed or cleanup uncertain");
    if (report && process.env.LOCALDOT_SAFETY_TASK5_REPORT)
      writeFileSync(
        process.env.LOCALDOT_SAFETY_TASK5_REPORT,
        JSON.stringify({ ...report, cleanup: "exact owned resources confirmed retired" }, null, 2) +
          "\n",
      );
  }, 180000);
});
