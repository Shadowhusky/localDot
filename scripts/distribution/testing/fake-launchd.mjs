#!/usr/bin/env node
// launchctl for the install-level update test: runs a job as launchd would, restarting it while
// it should stay up and ending its process group when it is booted out. Never calls launchctl.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.FLOW_ROOT ?? process.env.HOME ?? "";
const state = join(home, "services");
const [operation, first, second] = process.argv.slice(2);
appendFileSync(join(home, "launchctl.log"), `${process.argv.slice(2).join(" ")}\n`);
const label = (target) => target.split("/").pop();
const pidFile = (name) => join(state, `${name}.pid`);
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const loaded = (name) =>
  existsSync(pidFile(name)) && running(Number(readFileSync(pidFile(name), "utf8")));
function plist(path) {
  const text = readFileSync(path, "utf8");
  const plain = (value) =>
    value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  return {
    label: /<key>Label<\/key><string>([^<]*)</.exec(text)?.[1],
    args: [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => plain(m[1])),
    env: Object.fromEntries(
      [...dict.matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)].map((m) => [
        m[1],
        plain(m[2]),
      ]),
    ),
    cwd: /<key>WorkingDirectory<\/key><string>([^<]*)</.exec(text)?.[1],
    log: /<key>StandardOutPath<\/key><string>([^<]*)</.exec(text)?.[1],
  };
}
if (operation === "--supervise") {
  const job = plist(first);
  let child,
    stopping = false;
  const start = () => {
    const out = openSync(job.log, "a");
    child = spawn(job.args[0], job.args.slice(1), {
      cwd: job.cwd ?? "/",
      env: { HOME: home, PATH: process.env.PATH, ...job.env },
      stdio: ["ignore", out, out],
      detached: true,
    });
    child.on("exit", () => {
      if (stopping) process.exit(0);
      setTimeout(start, 200);
    });
  };
  process.on("SIGTERM", () => {
    stopping = true;
    if (child?.exitCode !== null) process.exit(0);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      process.exit(0);
    }, 5000).unref();
  });
  start();
} else if (operation === "print") process.exit(loaded(label(first)) ? 0 : 113);
else if (operation === "print-disabled") console.log("disabled services = {\n}");
else if (operation === "bootout") {
  const name = label(first);
  if (!loaded(name)) process.exit(3);
  const pid = Number(readFileSync(pidFile(name), "utf8"));
  process.kill(pid, "SIGTERM");
  const until = Date.now() + 8000;
  while (running(pid) && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  rmSync(pidFile(name), { force: true });
} else if (operation === "bootstrap") {
  const child = spawn(process.execPath, [process.argv[1], "--supervise", second], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(pidFile(plist(second).label), String(child.pid));
}
