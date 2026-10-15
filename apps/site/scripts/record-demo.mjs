// Records one website demo on a demo computer of its own, leaving the owner's settings and chat as
// they were: node scripts/record-demo.mjs qa/live/demos.json <demo-id> [--fresh]
// The demos file (in ignored qa/) gives each demo's dot, spending cap, task and any input files;
// the demo computer's id and each run's session are written beside it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASE = "http://127.0.0.1:4750";
const [configPath, id] = process.argv.slice(2);
if (!configPath || !id) throw new Error("Usage: record-demo.mjs <demos.json> <demo-id> [--fresh]");
const HERE = `${dirname(resolve(configPath))}/`;
const token = readFileSync(`${process.env.HOME}/.localdot/daemon-token`, "utf8").trim();
const headers = { Authorization: `Bearer ${token}`, Origin: BASE };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = "GET", body, raw) {
  const r = await fetch(BASE + path, {
    method,
    headers: raw ? headers : { ...headers, "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  if (!r.ok)
    throw Object.assign(new Error(`${method} ${path}: ${r.status} ${text}`), { status: r.status });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const demos = JSON.parse(readFileSync(resolve(configPath), "utf8"));
const demo = demos[id];
if (!demo) throw new Error(`Unknown demo ${id}`);

// The owner's own task must not be running: the demo shares Docker with it.
const brains = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
  .split("\n")
  .filter((n) => /brain/.test(n));
if (brains.length) throw new Error(`A task is running (${brains.join(", ")}); try later.`);
const before = await api("/api/conversation");
const previous = before.sessions.at(-1) ?? null;
if (previous) {
  const live = await api(`/api/agent/sessions/${previous}`).catch((e) =>
    e.status === 404 ? null : Promise.reject(e),
  );
  if (live && !["idle", "ended"].includes(live.status))
    throw new Error(`The owner's task ${previous} is ${live.status}; try later.`);
}

// The demo computer: one of its own, made once.
const cellFile = `${HERE}demo-computer.json`;
let cellId = existsSync(cellFile) ? JSON.parse(readFileSync(cellFile, "utf8")).id : null;
if (!cellId) {
  const made = await api("/api/cells", "POST", { scale: 2 });
  cellId = made.id;
  writeFileSync(cellFile, JSON.stringify({ id: cellId, createdAt: new Date().toISOString() }));
  log("created demo computer", cellId);
}
let cell = await api(`/api/cells/${cellId}`);
// A fresh desktop for each demo: the computer is restarted, its files kept.
if (cell.state === "ready" && process.argv.includes("--fresh")) {
  await api(`/api/cells/${cellId}/stop`, "POST");
  for (let i = 0; i < 90 && cell.state !== "stopped"; i++) {
    await wait(2000);
    cell = await api(`/api/cells/${cellId}`);
  }
  log("demo computer stopped for a fresh desktop");
}
if (cell.state === "stopped") await api(`/api/cells/${cellId}/start`, "POST");
for (let i = 0; i < 180 && cell.state !== "ready"; i++) {
  await wait(2000);
  cell = await api(`/api/cells/${cellId}`);
}
if (cell.state !== "ready") throw new Error(`Demo computer is ${cell.state}`);
log("demo computer ready");

for (const input of demo.inputs ?? []) {
  const name = input.split("/").at(-1);
  try {
    await api(
      `/api/cells/${cellId}/upload?name=${encodeURIComponent(name)}`,
      "POST",
      undefined,
      readFileSync(`${HERE}${input}`),
    );
    log("uploaded", name);
  } catch (error) {
    // Uploads never replace a file: an earlier run's copy is the same file.
    if (error.status !== 409) throw error;
    log("already on the computer:", name);
  }
}

const original = await api("/api/agent/settings");
let session;
try {
  await api("/api/conversation/new", "POST");
  await api("/api/agent/settings", "PUT", {
    ...original,
    persona: demo.persona,
    taskBudgetUSD: demo.budgetUSD,
  });
  session = await api(`/api/cells/${cellId}/agent`, "POST", { task: demo.task });
} finally {
  await api("/api/agent/settings", "PUT", original);
  log("owner's settings restored");
}
const started = new Date().toISOString();
writeFileSync(
  `${HERE}demo-${id}-session.json`,
  JSON.stringify({ id, cellId, ...session, started, previous }, null, 2),
);
log("started", session.sessionId);

try {
  for (;;) {
    await wait(15000);
    const s = await api(`/api/agent/sessions/${session.sessionId}`).catch((e) =>
      e.status === 404 ? null : Promise.reject(e),
    );
    if (!s || ["idle", "ended"].includes(s.status)) {
      log("ended", s?.status ?? "(not live)");
      break;
    }
    if (s.status === "waiting_user") log("WAITING FOR THE USER: check the demo task");
    log(s.status, `${s.toolCalls ?? "?"} tool calls`);
  }
} finally {
  // Give the owner their conversation back.
  try {
    if (previous) await api("/api/conversation/continue", "POST", { sessionId: previous });
    else await api("/api/conversation/new", "POST");
    log("owner's conversation restored", previous);
  } catch (e) {
    log("could not restore the owner's conversation yet:", e.message);
  }
}
