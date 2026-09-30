import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { localdotHome } from "./paths.ts";
import { loadOrCreateToken } from "./token.ts";

const port = Number(process.env.LOCALDOT_PORT ?? 4750);
const home = localdotHome();
const tokenFile = join(home, "daemon-token");
const token = loadOrCreateToken(tokenFile);
const app = createApp({ token, port });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`localdot daemon on http://127.0.0.1:${port} (token in ${tokenFile})`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message);
  process.exit(1);
});
