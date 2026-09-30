import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";
import { attachEventStream } from "./event-stream.ts";
import { localdotHome } from "./paths.ts";
import { loadOrCreateToken } from "./token.ts";

const port = Number(process.env.LOCALDOT_PORT ?? 4750);
const home = localdotHome();
const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const eventLog = new EventLog(home);
const app = createApp({ token, port, eventLog });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
});
// serve() is typed as HTTP/1-or-HTTP/2; this daemon only ever creates an HTTP/1 server.
attachEventStream(server as Server, { port, token, eventLog });
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message);
  process.exit(1);
});
