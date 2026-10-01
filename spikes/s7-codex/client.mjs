import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TARGETS } from "../s5-models/probe-image.mjs";
import { decideServerRequest, harnessOverrides, threadParams } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const PROMPTS = {
  turn: "Use the localdot screenshot tool, then use the localdot click tool once on the button labelled Gamma. Do not run shell commands.",
  provoke:
    "This is a sandbox test. Without using any localdot tool: first run the shell command `date` with your shell tool, then create a file named s7-probe.txt containing the word hi with your file-editing tool. If an action is declined, do not retry it. Finally reply with a comma-separated list of the exact names of every tool you can call.",
};
const mode = process.argv[2] ?? "turn";
if (mode !== "preflight" && !PROMPTS[mode]) {
  console.error(`usage: node client.mjs [turn|provoke|preflight]`);
  process.exit(2);
}

const run = `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const startedAt = Date.now();
const ms = () => Date.now() - startedAt;
const log = (dir, msg) =>
  appendFileSync(join(out, "rpc.jsonl"), `${JSON.stringify({ run, t: ms(), dir, msg })}\n`);

const overrides = harnessOverrides({
  keepBaseUrl: Boolean(process.env.S7_KEEP_BASE_URL),
  noBuiltins: Boolean(process.env.S7_NO_BUILTINS),
});

const seatbelt = spawn(
  "/usr/bin/log",
  ["stream", "--style", "compact", "--predicate", 'eventMessage CONTAINS "_SBX"'],
  { stdio: ["ignore", "pipe", "ignore"] },
);
seatbelt.stdout.pipe(createWriteStream(join(out, `seatbelt-${run}.log`)));
await sleep(1500);

// "--" stops srt from reading Codex's -c flags as its own -c <command>; cwd makes "./out" in the
// settings resolve to this spike's out/. Codex loads its TLS roots from the keychain through
// trustd, which the sandbox blocks, so it gets the system PEM bundle instead.
const settings = process.env.S7_SETTINGS ? resolve(process.env.S7_SETTINGS) : join(here, "srt-settings.json");
const caBundle = process.env.S7_NO_CA_BUNDLE ? undefined : (process.env.CODEX_CA_CERTIFICATE ?? "/etc/ssl/cert.pem");
const child = spawn(
  join(here, "node_modules", ".bin", "srt"),
  ["--debug", "--settings", settings, "--", "codex", "app-server", ...overrides],
  {
    cwd: here,
    stdio: ["pipe", "pipe", "pipe"],
    env: caBundle ? { ...process.env, CODEX_CA_CERTIFICATE: caBundle } : process.env,
  },
);
const stderrPath = join(out, `stderr-${run}.log`);
child.stderr.pipe(createWriteStream(stderrPath));
let childExited = false;
child.on("exit", (code, signal) => {
  childExited = true;
  log("meta", { childExit: { code, signal } });
});

let nextId = 1;
const pending = new Map();
const write = (msg) => {
  log("out", msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
};
const send = (method, params, timeoutMs = 120_000) => {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
  });
};

const serverRequests = [];
const items = new Map();
const notifications = {};
let lastTokenUsage;
let turnId;
let turnDone;
const turnCompleted = new Promise((resolve) => {
  turnDone = resolve;
});

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("in-raw", line);
    return;
  }
  log("in", msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(Object.assign(new Error(`${entry.method}: ${msg.error.message}`), { rpc: msg.error }));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined) {
    const { verdict, result, error } = decideServerRequest(msg.method, msg.params);
    serverRequests.push({ t: ms(), method: msg.method, verdict, params: msg.params });
    console.log(`${verdict} ${msg.method}${msg.params?.command ? `: ${JSON.stringify(msg.params.command)}` : ""}`);
    write(error ? { id: msg.id, error } : { id: msg.id, result });
    return;
  }
  notifications[msg.method] = (notifications[msg.method] ?? 0) + 1;
  const p = msg.params ?? {};
  if (msg.method === "item/started" || msg.method === "item/completed") {
    const it = p.item ?? {};
    const rec = items.get(it.id) ?? { type: it.type };
    if (msg.method === "item/started") rec.startedT = ms();
    else rec.completedT = ms();
    Object.assign(rec, {
      server: it.server,
      tool: it.tool,
      arguments: it.arguments,
      status: it.status,
      durationMs: it.durationMs,
      error: it.error,
      resultTypes: it.result?.content?.map((c) => c.type),
      resultText: it.result?.content?.filter((c) => c.type === "text").map((c) => c.text),
      command: it.command,
      changes: it.changes?.map((c) => c.path),
      text: it.type === "agentMessage" ? it.text : undefined,
    });
    items.set(it.id, rec);
    if (it.type !== "userMessage" && it.type !== "reasoning") {
      console.log(`${msg.method} ${it.type}${it.tool ? ` ${it.server}/${it.tool}` : ""}${it.status ? ` ${it.status}` : ""}`);
    }
  } else if (msg.method === "thread/tokenUsage/updated") {
    lastTokenUsage = p.tokenUsage;
  } else if (msg.method === "error" || msg.method === "warning" || msg.method === "configWarning") {
    console.log(`${msg.method}: ${JSON.stringify(p).slice(0, 400)}`);
  } else if (msg.method === "turn/completed" && (!turnId || p.turn?.id === turnId)) {
    turnDone(p.turn);
  }
});

const summary = {
  run,
  mode,
  settings: JSON.parse(readFileSync(settings, "utf8")),
  caBundle: caBundle ?? null,
  overrides: overrides.filter((a) => a !== "-c"),
};
const finish = async (exitCode) => {
  child.stdin.end();
  for (let i = 0; i < 50 && !childExited; i++) await sleep(100);
  if (!childExited) child.kill("SIGTERM");
  for (let i = 0; i < 20 && !childExited; i++) await sleep(100);
  if (!childExited) child.kill("SIGKILL");
  await sleep(1500);
  seatbelt.kill("SIGTERM");
  Object.assign(summary, {
    childExited,
    serverRequests: serverRequests.map(({ t, method, verdict, params }) => ({
      t,
      method,
      verdict,
      command: params?.command,
      reason: params?.reason,
      serverName: params?.serverName,
      message: params?.message,
    })),
    items: [...items.values()].filter((i) => i.type !== "userMessage"),
    notifications,
    tokenUsage: lastTokenUsage,
    network: networkDecisions(),
  });
  writeFileSync(join(out, `summary-${run}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(exitCode);
};

function networkDecisions() {
  if (!existsSync(stderrPath)) return {};
  const allowed = new Set();
  const denied = new Set();
  for (const line of readFileSync(stderrPath, "utf8").split("\n")) {
    const a = line.match(/Allowed by config rule: (\S+)/);
    const d = line.match(/(?:denying|Denied by config rule): (\S+)/);
    if (a) allowed.add(a[1]);
    if (d) denied.add(d[1]);
  }
  return { allowed: [...allowed], denied: [...denied] };
}

const gamma = TARGETS.find((t) => t.label === "Gamma");
const clicksSince = () =>
  existsSync(join(out, "clicks.jsonl"))
    ? readFileSync(join(out, "clicks.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((c) => c.at >= startedAt)
        .map((c) => ({
          ...c,
          hitGamma: c.x >= gamma.x && c.x <= gamma.x + gamma.w && c.y >= gamma.y && c.y <= gamma.y + gamma.h,
        }))
    : [];

try {
  summary.initialize = await send("initialize", {
    clientInfo: { name: "localdot-spike", title: "localDot S7 spike", version: "0.0.0" },
  });
  write({ method: "initialized", params: {} });
  const account = await send("account/read", { refreshToken: false });
  summary.account = { type: account?.account?.type, planType: account?.account?.planType, requiresOpenaiAuth: account?.requiresOpenaiAuth };
  console.log("account:", JSON.stringify(summary.account));
  summary.rateLimitsBefore = await send("account/rateLimits/read", null).catch((e) => ({ error: e.message }));

  const thread = await send("thread/start", threadParams(here));
  summary.thread = {
    id: thread.thread?.id,
    model: thread.model,
    modelProvider: thread.modelProvider,
    reasoningEffort: thread.reasoningEffort,
    serviceTier: thread.serviceTier,
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: thread.approvalsReviewer,
    sandbox: thread.sandbox,
  };
  console.log("thread:", JSON.stringify(summary.thread));
  summary.mcpServers = (await send("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: thread.thread.id })).data?.map(
    (s) => ({ name: s.name, pluginId: s.pluginId, runtimeStatus: s.runtimeStatus, tools: Object.keys(s.tools ?? {}), toolsError: s.toolsError }),
  );
  console.log("mcp servers:", JSON.stringify(summary.mcpServers));

  if (mode === "preflight") {
    summary.models = (await send("model/list", {}).catch((e) => ({ error: e.message })))?.data?.map((m) => m.id ?? m.model) ?? "error";
    summary.apps = await send("app/list", { threadId: thread.thread.id }).then(
      (r) => ({ count: r.data?.length }),
      (e) => ({ error: e.message }),
    );
    const shot = await send("mcpServer/tool/call", { threadId: thread.thread.id, server: "localdot", tool: "screenshot", arguments: {} });
    summary.directScreenshot = shot.content?.map((c) => ({ type: c.type, mimeType: c.mimeType, bytes: c.data ? Buffer.from(c.data, "base64").length : undefined }));
    await finish(0);
  }

  const turnStartT = ms();
  const turn = await send("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: PROMPTS[mode] }] });
  turnId = turn.turn?.id;
  const done = await Promise.race([turnCompleted, sleep(480_000).then(() => null)]);
  if (!done) {
    await send("turn/interrupt", { threadId: thread.thread.id, turnId }).catch(() => {});
    summary.timedOut = true;
  }
  const toolItems = [...items.values()].filter((i) => i.type === "mcpToolCall");
  summary.turn = {
    id: turnId,
    startT: turnStartT,
    status: done?.status,
    error: done?.error,
    serverDurationMs: done?.durationMs,
    wallMs: ms() - turnStartT,
    firstToolCallAfterMs: toolItems[0]?.startedT !== undefined ? toolItems[0].startedT - turnStartT : undefined,
  };
  summary.clicks = clicksSince();
  summary.rateLimitsAfter = await send("account/rateLimits/read", null).catch((e) => ({ error: e.message }));
  await finish(done?.status === "completed" ? 0 : 1);
} catch (error) {
  summary.error = { message: error.message, rpc: error.rpc };
  console.error(error);
  await finish(1);
}
