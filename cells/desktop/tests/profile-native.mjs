import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createDesktopdApp, DesktopdTools, prepareDesktopBrowser, serve } from "/work/profiles.mjs";

const checks = [],
  processes = [],
  sockets = [];
const A = "01J" + "0".repeat(22) + "1",
  B = "01J" + "0".repeat(22) + "2",
  C = "01J" + "0".repeat(22) + "3";
const token = "d".repeat(43);
const installed = process.env.LOCALDOT_PROFILE_IMAGE_PROBE === "1";
function passed(message) {
  checks.push(message);
  console.log(message);
}
function owned(command, args) {
  const process = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  const record = { process, stderr: "", exit: undefined };
  record.exited = new Promise((resolve) => process.once("exit", resolve));
  record.closed = new Promise((resolve) =>
    process.once("close", (code, signal) => {
      record.exit = { code, signal };
      resolve();
    }),
  );
  process.stderr.on("data", (b) => {
    record.stderr = (record.stderr + b.toString()).slice(-4096);
  });
  process.once("error", (e) => {
    record.stderr = e.message;
  });
  processes.push(record);
  return record;
}
async function until(fn, label) {
  let error;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      error = e;
    }
    await delay(30);
  }
  throw new Error(label + ": " + String(error || processes.map((p) => p.stderr).join("\n")));
}
async function connect() {
  const page = await until(async () => {
    const response = await fetch("http://127.0.0.1:9222/json/list", {
      signal: AbortSignal.timeout(500),
    });
    return (await response.json()).find(
      (p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:8983/"),
    );
  }, "Chromium page readiness");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data);
    const entry = pending.get(reply.id);
    if (entry) {
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      reply.error
        ? entry.reject(new Error(JSON.stringify(reply.error)))
        : entry.resolve(reply.result);
    }
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("browser closed"));
    }
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error("CDP timeout"));
      }, 3000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  return {
    call,
    state: async () =>
      (
        await call("Runtime.evaluate", {
          expression:
            'JSON.stringify({cookie:document.cookie,local:localStorage.getItem("profile-canary"),ready:document.readyState})',
          returnByValue: true,
        })
      ).result.value,
  };
}
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/seed") res.setHeader("set-cookie", "profile_canary=task; Path=/; Max-Age=3600");
  res.end(
    "<!doctype html><title>Local profile acceptance</title><p>Synthetic local fixture</p>" +
      (req.url === "/seed" ? '<script>localStorage.setItem("profile-canary","task")</script>' : ""),
  );
});
await new Promise((resolve) => fixture.listen(8983, "127.0.0.1", resolve));
const app = createDesktopdApp({
  token,
  scale: 1,
  display: ":93",
  readXsettings: async () => null,
  readScreen: async () => null,
  prepareBrowser: prepareDesktopBrowser,
});
const service = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((resolve) =>
  service.listening ? resolve() : service.once("listening", resolve),
);
const tools = new DesktopdTools({ baseUrl: `http://127.0.0.1:${service.address().port}`, token });
const launch = (path, binary = "/usr/local/bin/localdot-chromium") =>
  installed
    ? owned(binary, [`http://127.0.0.1:8983/${path}`])
    : owned("/bin/bash", ["/usr/local/bin/localdot-chromium", `http://127.0.0.1:8983/${path}`]);
const metadata = async () =>
  JSON.parse(await readFile("/run/localdot-desktop-browser/state.json", "utf8"));
try {
  owned("/usr/bin/Xvfb", [":93", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"]);
  await until(() => readFile("/tmp/.X93-lock", "utf8"), "X display readiness");
  if (installed) {
    for (const name of ["chromium", "chromium-browser"]) {
      const binary = `/usr/local/bin/${name}`;
      assert.equal(await readlink(binary), "localdot-chromium");
      assert.match(execFileSync(binary, ["--version"], { encoding: "utf8" }), /Chromium/);
    }
    passed("Installed CLI browser aliases resolve to the managed launcher and report a version");
  }
  await mkdir("/config/.config/chromium/Default", { recursive: true });
  await writeFile("/config/.config/chromium/Default/legacy-canary", "untouched");
  await prepareDesktopBrowser(null);
  await tools.prepareBrowser(A);
  const first = await metadata();
  const firstLaunch = launch("seed");
  const firstPage = await connect();
  await until(async () => {
    const state = JSON.parse(await firstPage.state());
    return state.cookie === "profile_canary=task" && state.local === "task";
  }, "seeded real cookie");
  passed(
    "Real desktop Chromium launched through managed wrapper and stored synthetic cookie/localStorage",
  );
  await tools.prepareBrowser(B);
  await firstLaunch.closed;
  assert.notEqual((await metadata()).generation, first.generation);
  launch("check", "/usr/local/bin/chromium");
  const secondPage = await connect();
  const fresh = JSON.parse(await secondPage.state());
  assert.equal(fresh.cookie, "");
  assert.equal(fresh.local, null);
  passed(
    "Next task through authenticated desktop HTTP retired Chromium and has no prior cookie/localStorage",
  );
  await secondPage.call("Runtime.evaluate", {
    expression:
      'document.cookie="current=kept;path=/";localStorage.setItem("profile-canary","current")',
  });
  const before = (await metadata()).generation;
  await tools.prepareBrowser(B);
  assert.equal((await metadata()).generation, before);
  assert.equal(JSON.parse(await secondPage.state()).cookie, "current=kept");
  passed("A duplicate task-preparation receipt does not reset its current browser or cookies");
  const activeLaunch = processes.at(-1);
  activeLaunch.process.kill("SIGKILL");
  // The surviving browser still owns the launcher's inherited stderr pipe. Observe process
  // exit here; physical pipe drain is checked only after recovery has retired that browser.
  await activeLaunch.exited;
  assert.equal(JSON.parse(await secondPage.state()).local, "current");
  await prepareDesktopBrowser(null);
  await tools.prepareBrowser(C);
  launch("check", "/usr/local/bin/chromium-browser");
  const recovered = await connect();
  const recoveredState = JSON.parse(await recovered.state());
  assert.equal(recoveredState.cookie, "");
  assert.equal(recoveredState.local, null);
  passed(
    "Recovery after managed-launcher crash retires surviving native Chromium and clears browser state",
  );
  assert.equal(
    await readFile("/config/.config/chromium/Default/legacy-canary", "utf8"),
    "untouched",
  );
  passed("The managed browser neither reused nor deleted the unrelated legacy home profile");
  console.log(JSON.stringify({ result: "PASS", checks }));
} finally {
  for (const socket of sockets) socket.close();
  await prepareDesktopBrowser(null).catch(() => {});
  await tools.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  for (const record of processes) {
    if (!record.exit) record.process.kill("SIGKILL");
    await record.closed;
  }
}
