import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { progressChannel } from "../../../cli/src/install/browser-progress.ts";
import { MemoryStore } from "../../../daemon/src/agent/memory.ts";
import { SettingsStore } from "../../../daemon/src/agent/settings.ts";
import { createApp } from "../../../daemon/src/app.ts";
import { TicketRegistry } from "../../../daemon/src/cells/secrets.ts";
import { FakeOrchestrator } from "../../../daemon/src/cells/testing/fake-orchestrator.ts";
import { EventLog } from "../../../daemon/src/event-log.ts";
import { InstallCodes } from "../../../daemon/src/install-codes.ts";

const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing setup fixture listener");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

// Real production HTTP guards, code exchange, static UI, settings and progress page. Only the
// computer/key inventory/catalog are inert fixture data. No Docker, account or Keychain access.
export async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "localdot-setup-browser-"));
  const log = new EventLog(home);
  const token = randomBytes(32).toString("base64url");
  const capability = randomBytes(32).toString("base64url");
  const requests: Array<{ method: string; path: string; referrer: string | null }> = [];
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-03T00:00:00Z");
  const unexpected = () => {
    throw new Error("Unexpected setup fixture effect");
  };
  let app: ReturnType<typeof createApp>;
  const server = createServer(
    getRequestListener((request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        referrer: request.headers.get("referer"),
      });
      return app.fetch(request);
    }),
  );
  let progress: Server | undefined;
  try {
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const codes = new InstallCodes(token, port);
    app = createApp({
      port,
      token,
      eventLog: log,
      installCodes: codes,
      ui: { dir: fileURLToPath(new URL("../../dist", import.meta.url)) },
      cells: { cells: new FakeOrchestrator(), tickets: new TicketRegistry() },
      agent: {
        home,
        settings: new SettingsStore(home),
        catalog: { get: () => catalog, refresh: async () => catalog },
        keyd: { secrets: async () => [] },
        memory: new MemoryStore(home),
        skills: () => [],
        runner: { start: unexpected, get: () => undefined, raiseBudget: unexpected },
        desktop: unexpected,
        redactUserText: (text) => text,
        appendTo: unexpected,
        harness: () => ({ available: false, reason: "No account in setup fixture" }),
      },
    });
    app.get("/api/keyd", (c) =>
      c.json({ online: true, bootId: "setup-fixture", audit: { ok: true } }),
    );
    app.get("/api/keys", (c) => c.json({ keys: [] }));
    app.get("/api/session-index", (c) => c.json({ sessions: [], next: null }));
    const channel = progressChannel(capability, port);
    let progressOrigin = "";
    progress = createServer((request, response) =>
      channel.handle(progressOrigin, request, response),
    );
    progressOrigin = `http://127.0.0.1:${await listen(progress)}`;
    return {
      origin,
      progressOrigin,
      url: `${progressOrigin}/#progress=${capability}`,
      channel,
      requests,
      issue: () => `${origin}/#code=${codes.issue().code}`,
      async close() {
        await close(progress as Server);
        await close(server);
        log.close();
        rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (progress?.listening) await close(progress);
    if (server.listening) await close(server);
    log.close();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
