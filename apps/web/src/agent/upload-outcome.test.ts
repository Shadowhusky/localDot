import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import { MemoryStore } from "../../../daemon/src/agent/memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "../../../daemon/src/agent/routes.ts";
import { AgentError } from "../../../daemon/src/agent/runner.ts";
import { AgentSession } from "../../../daemon/src/agent/session.ts";
import { SettingsStore } from "../../../daemon/src/agent/settings.ts";
import { Transfers } from "../../../daemon/src/agent/transfers.ts";
import { DesktopdTools } from "../../../daemon/src/desktopd/tools-client.ts";
import { createApi } from "../lib/api.ts";
import { uploadFile } from "./file-transfer.ts";

const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof agentRoutes>[0] };

const CELL = "01JXYZ0000000000000000CE11",
  SESSION = "01JXYZ0000000000000000SESS";
for (const control of ["takeover", "stop", "cell readiness loss"] as const)
  it(`keeps a committed upload uncertain when ${control} wins before its acknowledgment`, async () => {
    const home = mkdtempSync(join(tmpdir(), "localdot-upload-outcome-"));
    const session = new AgentSession(SESSION, CELL, "synthetic task", {
      append: () => undefined as never,
    });
    const generation = session.beginBrain();
    session.status = "running";
    const transfers = new Transfers(),
      desktop = new Hono();
    addToolRoutes(desktop, {
      home,
      env: {},
      browser: {
        read: async () => {
          throw new Error("No browser fixture");
        },
        navigate: async () => {
          throw new Error("No browser fixture");
        },
      },
    });
    let published = false,
      status: number | undefined;
    const tools = new DesktopdTools(
      { baseUrl: "http://owned-inert-desktop", token: "fake-tool-token" },
      async (url, init) => {
        const reply = await desktop.fetch(new Request(url, init));
        if (reply.status === 200) {
          // Actual file route has already atomically published before the response reaches its owner.
          published = readFileSync(join(home, "Downloads/sample.txt"), "utf8") === "original";
          if (control === "stop") session.stop();
          else if (control === "takeover")
            void session.takeover("login", "Synthetic control transfer").catch(() => {});
        }
        return reply;
      },
    );
    const app = new Hono();
    const deps: AgentRoutesDeps = {
      home,
      settings: new SettingsStore(home),
      memory: new MemoryStore(home),
      catalog: {
        fresh() {
          return Promise.resolve(this.get());
        },
        freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
        get: () => undefined,
        refresh: async () => {
          throw new Error("No catalog fixture");
        },
      },
      keyd: { secrets: async () => [] },
      skills: () => [],
      runner: {
        get: () => session,
        start: async () => {
          throw new Error("No model fixture");
        },
        raiseBudget: async () => {},
      },
      redactUserText: (text) => text,
      appendTo: () => {},
      desktop: (_cell, requestSignal) => {
        const toolLease = session.admit(generation, requestSignal);
        const lease = transfers.acquire(CELL, [requestSignal, toolLease.signal], () => {
          toolLease.check();
          if (published && control === "cell readiness loss")
            throw new AgentError(409, "the computer changed during the upload");
        });
        return {
          tools,
          signal: lease.signal,
          check: lease.check,
          release: () => {
            lease.release();
            toolLease.finish();
          },
        };
      },
    };
    agentRoutes(app, deps);
    const api = createApi("fake-token", {
      origin: "http://owned-inert-agent",
      fetchImpl: async (url, init) => {
        const reply = await app.fetch(new Request(url, init));
        status = reply.status;
        return reply;
      },
    });
    try {
      const outcome = await uploadFile(
        api,
        CELL,
        new File(["original"], "sample.txt"),
        new AbortController().signal,
      ).then(
        (path) => ({ ok: true, path, uncertain: false }),
        (error) => ({ ok: false, uncertain: error.uncertain as boolean }),
      );
      expect(published).toBe(true);
      expect(readFileSync(join(home, "Downloads/sample.txt"), "utf8")).toBe("original");
      expect(outcome.ok).toBe(false);
      expect(outcome.uncertain, `HTTP ${status} was returned after durable publication`).toBe(true);
    } finally {
      session.stop();
      transfers.close();
      await transfers.settled();
      await tools.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
