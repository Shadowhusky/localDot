import { readFileSync } from "node:fs";
import { join } from "node:path";
import { msToSeconds, sessionMsOf } from "@localdot/protocol";
import { WebSocket } from "ws";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { parsePuppetScript } from "./puppet/script.ts";

// usage: pnpm --filter @localdot/daemon puppet <script.json> [--cell <id>]
const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: pnpm --filter @localdot/daemon puppet <script.json> [--cell <id>]");
  process.exit(2);
}
const cellArg = rest.indexOf("--cell") >= 0 ? rest[rest.indexOf("--cell") + 1] : undefined;
const home = localdotHome();
const port = parsePort(process.env.LOCALDOT_PORT);
const origin = `http://127.0.0.1:${port}`;
const token = readFileSync(join(home, "daemon-token"), "utf8").trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const script = parsePuppetScript(JSON.parse(readFileSync(file, "utf8")));

const cells = (await (await fetch(`${origin}/api/cells`, { headers })).json()) as {
  id: string;
  state: string;
}[];
const cell = cellArg ? cells.find((c) => c.id === cellArg) : cells.find((c) => c.state === "ready");
if (!cell) {
  console.error("no ready cell; start the computer first");
  process.exit(1);
}
const res = await fetch(`${origin}/api/cells/${cell.id}/puppet`, {
  method: "POST",
  headers,
  body: JSON.stringify(script),
});
if (res.status !== 202) {
  console.error(`puppet: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { sessionId } = (await res.json()) as { sessionId: string };
console.log(`session ${sessionId} on cell ${cell.id}`);
const ws = new WebSocket(
  `ws://127.0.0.1:${port}/api/sessions/${sessionId}/stream`,
  ["localdot.v1", `localdot.token.${token}`],
  { origin },
);
ws.on("message", (data) => {
  const e = JSON.parse(String(data)) as { t: number; type: string; data: Record<string, unknown> };
  const label =
    typeof e.data.label === "string"
      ? ` ${e.data.label}`
      : e.type === "action.target"
        ? ` ${JSON.stringify((e.data.target as { role?: string; name?: string }).role)} ${JSON.stringify((e.data.target as { name?: string }).name)}`
        : "";
  console.log(`${msToSeconds(sessionMsOf(e)).toFixed(3)}s ${e.type}${label}`);
  if (e.type === "session.end") {
    ws.close();
    process.exit(e.data.reason === "done" ? 0 : 1);
  }
});
ws.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
