import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { harnessOverrides, threadParams } from "./harness.mjs";

// Points a throwaway provider at a loopback mock with a dummy key, so no model quota is used and
// no OpenAI token leaves Codex. It records the tools Codex offers the model and, with
// S7_MOCK_EXEC set, plays a model that calls code mode's `exec` with that JavaScript.
const here = dirname(fileURLToPath(import.meta.url));
const [label = "spike", ...extraFlags] = process.argv.slice(2);
const MOCK_KEY = "s7-mock-key";
const script = process.env.S7_MOCK_EXEC;

const requests = [];
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = (id) => ({
  type: "response.completed",
  response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
});
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    requests.push({ dummyKeyOnly: req.headers.authorization === `Bearer ${MOCK_KEY}`, body: JSON.parse(body) });
    const id = `resp_s7_${requests.length}`;
    const item =
      script && requests.length === 1
        ? { type: "custom_tool_call", id: "ctc_s7", call_id: "call_s7", namespace: "functions", name: "exec", input: script, status: "completed" }
        : { type: "message", role: "assistant", id: `msg_${id}`, content: [{ type: "output_text", text: "ok" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([{ type: "response.created", response: { id } }, { type: "response.output_item.done", item }, completed(id)]));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const child = spawn(
  "codex",
  [
    "app-server",
    ...harnessOverrides({ noBuiltins: Boolean(process.env.S7_NO_BUILTINS) }),
    "-c", `model_providers.s7mock={ name = "s7mock", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses", env_key = "S7_MOCK_KEY", request_max_retries = 0, stream_max_retries = 0 }`,
    "-c", `model_provider="s7mock"`,
    "-c", `model="gpt-6-astra"`,
    ...extraFlags,
  ],
  { cwd: here, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, S7_MOCK_KEY: MOCK_KEY } },
);
let exited = false;
child.on("exit", () => {
  exited = true;
});

let nextId = 1;
const pending = new Map();
const events = [];
let turnDone = false;
const send = (method, params) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) entry?.reject(new Error(msg.error.message));
    else entry?.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined) {
    events.push({ request: msg.method, params: msg.params });
    child.stdin.write(`${JSON.stringify({ id: msg.id, result: { decision: "decline" } })}\n`);
    return;
  }
  const item = msg.params?.item;
  if (msg.method === "item/started" || msg.method === "item/completed") {
    if (item.type !== "userMessage") events.push({ notification: msg.method, type: item.type, status: item.status, tool: item.tool });
  } else if (msg.method?.startsWith("item/") || msg.method === "error") {
    events.push({ notification: msg.method });
  }
  if (msg.method === "turn/completed") turnDone = true;
});

const toolName = (t) => t.name ?? t.type;
const offered = (body) => [...(body.tools ?? []), ...(body.input ?? []).filter((i) => i.type === "additional_tools").flatMap((i) => i.tools)];
const nestedInExec = (tools) =>
  tools
    .flatMap((t) => [t, ...(t.tools ?? [])])
    .filter((t) => t.name === "exec")
    .flatMap((t) => [...(t.description ?? "").matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]));

try {
  await send("initialize", { clientInfo: { name: "localdot-spike-tools", version: "0.0.0" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const thread = await send("thread/start", threadParams(here));
  if (thread.modelProvider !== "s7mock") throw new Error(`provider is ${thread.modelProvider}, refusing to start a turn`);
  await send("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: thread.thread.id });
  await send("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "hello" }] });
  for (let i = 0; i < 300 && !turnDone; i++) await sleep(100);
} finally {
  child.stdin.end();
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) child.kill("SIGKILL");
  server.close();
}

if (requests.length === 0) {
  console.error("no request captured");
  process.exit(1);
}
const tools = offered(requests[0].body);
const execOutput = requests
  .slice(1)
  .flatMap((r) => r.body.input ?? [])
  .find((i) => i.type === "custom_tool_call_output" && i.call_id === "call_s7")?.output;
const result = {
  label,
  extraFlags,
  dummyKeyOnly: requests.every((r) => r.dummyKeyOnly),
  model: requests[0].body.model,
  modelVisibleTools: tools.map((t) => (t.tools ? `${toolName(t)}.{${t.tools.map(toolName).join(",")}}` : toolName(t))),
  callableFromExec: nestedInExec(tools),
  ...(script ? { script, execOutput, events, turnCompleted: turnDone } : {}),
};
writeFileSync(join(here, "out", `tools-${label}.json`), `${JSON.stringify({ ...result, requests: requests.map((r) => r.body) }, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
