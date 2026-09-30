import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The pip entry point chmods the root-owned binary and dies with EPERM as abc, so exec the binary.
const DRIVER = "/opt/venv/lib/python3.14/site-packages/cua_driver/bin/cua-driver";

const dbus = process.env.LD_DBUS;
if (!dbus) throw new Error("set LD_DBUS to the desktop's DBUS_SESSION_BUS_ADDRESS value");
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const transport = new StdioClientTransport({
  command: "docker",
  args: ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", "-e", `DBUS_SESSION_BUS_ADDRESS=${dbus}`,
    "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", "-e", "CUA_DRIVER_RS_UPDATE_CHECK=0",
    "ld-s2", DRIVER, "mcp", ...(process.env.LD_DRIVER_ARGS ?? "").split(" ").filter(Boolean)],
});
const client = new Client({ name: "localdot-s2-probe", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
writeFileSync(join(out, "tools.json"), JSON.stringify(tools, null, 2));
if (!process.argv[2]) console.log(tools.map((t) => t.name).join("\n"));

export async function call(name, args) {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Math.round(performance.now() - t0);
  const file = join(out, `${name}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return { result, ms, file };
}

if (process.argv[2] === "call") {
  const [, , , name, json = "{}", times = "1"] = process.argv;
  const runs = [];
  for (let i = 0; i < Number(times); i++) {
    const { result, ms, file } = await call(name, JSON.parse(json));
    runs.push(ms);
    if (i === 0) {
      console.log(`saved ${file}`);
      console.log(JSON.stringify(result, null, 2).slice(0, 4000));
    }
  }
  const sorted = [...runs].sort((a, b) => a - b);
  console.log(`${name} took ${runs.join(" ")} ms; median ${sorted[Math.floor(sorted.length / 2)]}`);
}

// Snapshots and element tokens live only inside one MCP session, so multi-step checks run here:
// node probe.mjs seq '[["get_window_state",{...}],["click",{"element_token":{"$label":"Maximize"}}]]'
if (process.argv[2] === "seq") {
  let elements = [];
  const resolve = (args) =>
    JSON.parse(JSON.stringify(args), (_, v) => {
      if (!v || typeof v !== "object" || !("$label" in v)) return v;
      const hit = elements.find((e) => e.label === v.$label && e.element_token);
      if (!hit) throw new Error(`no element labelled ${v.$label}`);
      return hit.element_token;
    });
  for (const [name, args] of JSON.parse(process.argv[3])) {
    // The driver's agent cursor lives only as long as this session, so screenshots of it run mid-sequence.
    if (name === "$sh") {
      execSync(args, { stdio: "inherit", cwd: here });
      continue;
    }
    const { result, ms, file } = await call(name, resolve(args));
    if (name === "get_window_state") elements = result.structuredContent?.elements ?? [];
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text.split("\n")[0]);
    console.log(`${name} ${ms} ms -> ${file}\n  ${text.join("\n  ")}`);
  }
}
await client.close();
