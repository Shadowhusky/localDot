import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { serveUi } from "../../daemon/src/static-ui.ts";

const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const WEB = fileURLToPath(new URL("..", import.meta.url));

export interface KitGallery {
  origin: string;
  stop(): Promise<void>;
}

// Builds the kit gallery and serves it through the daemon's own static route, so it runs under the
// production CSP, on a port the OS picks.
export async function serveKitGallery(name: string): Promise<KitGallery> {
  const scratch = mkdtempSync(join(tmpdir(), `${name}-`));
  await build({
    configFile: join(WEB, "vite.kit-gallery.config.ts"),
    logLevel: "warn",
    build: { outDir: scratch, emptyOutDir: true, sourcemap: false },
  });
  const app = new Hono();
  serveUi(app, scratch);
  const server = createServer(getRequestListener((request) => app.fetch(request)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
