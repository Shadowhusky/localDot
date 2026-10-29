import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { writeInstance } from "./instance.ts";
import { DotsRegistry, registryPath } from "./registry.ts";
import { DotsError } from "./routes.ts";
import { DotsService } from "./service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const CODE = "q".repeat(43);
const TOKEN = "t".repeat(43);

interface Spawned {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: unknown };
  child: ChildProcess & { stdout: PassThrough; stdin: PassThrough };
  input: string[];
}

function computer(self = "main") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dots-service-")));
  dirs.push(root);
  const main = join(root, "main");
  const work = join(root, "work");
  for (const home of [main, work]) {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "daemon-token"), TOKEN, { mode: 0o600 });
  }
  writeFileSync(join(main, "agent.json"), JSON.stringify({ name: "Studio" }), { mode: 0o600 });
  writeInstance(work, {
    v: 1,
    id: "work",
    name: "Work",
    ports: { app: 5750, tool: 5751, keyd: [5760, 5789], preview: [5850, 5865] },
    keychainService: "localdot-keyd.work",
  });
  const registry = new DotsRegistry(registryPath({ XDG_CONFIG_HOME: join(root, "config") }), main);
  registry.update((entries) => [...entries, { id: "work", home: work }]);
  const running = new Set([4750]);
  const others = { busy: false, origins: ["https://studio.example.ts.net:5750"] };
  const spawned: Spawned[] = [];
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(`${init?.method ?? "GET"} ${url.port}${url.pathname}`);
    const port = Number(url.port);
    if (!running.has(port)) throw new TypeError("fetch failed");
    if (url.pathname === "/healthz") return new Response("ok");
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`)
      return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/api/dots/self") return Response.json(others);
    if (url.pathname === "/api/install-code")
      return Response.json({ code: CODE, expiresAt: Date.now() + 60_000 });
    return new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;
  const spawn = ((command: string, args: string[], options: Spawned["options"]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      unref() {},
    }) as unknown as Spawned["child"];
    const input: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => input.push(String(chunk)));
    spawned.push({ command, args, options, child, input });
    return child;
  }) as never;
  let busy = false;
  const service = new DotsService({
    self,
    registry,
    cli: { command: "/apps/localdot/bin/localdot", args: [], cwd: "/" },
    env: { HOME: "/Users/a", PATH: "/usr/bin", XDG_CONFIG_HOME: join(root, "config") },
    spawn,
    fetch,
    busy: () => busy,
    origins: () => ["https://studio.example.ts.net:4750"],
  });
  return {
    service,
    main,
    work,
    running,
    others,
    spawned,
    asked,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

const say = (child: Spawned["child"], message: unknown) =>
  child.stdout.write(`${JSON.stringify(message)}\n`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the dots on this computer, as the app sees them", () => {
  it("lists each dot by the name its own settings give it, with whether it runs", async () => {
    const c = computer();
    expect(await c.service.list()).toEqual({
      manage: true,
      dots: [
        { id: "main", name: "Studio", port: 4750, self: true, main: true, state: "running" },
        { id: "work", name: "Work", port: 5750, self: false, main: false, state: "stopped" },
      ],
    });
    c.running.add(5750);
    expect((await c.service.list()).dots[1]?.state).toBe("running");
    expect(c.service.self()).toEqual({
      busy: false,
      origins: ["https://studio.example.ts.net:4750"],
    });
  });

  it("adds a dot through the localdot command and relays its sealed passphrase", async () => {
    const c = computer();
    const job = c.service.add({ name: "Home", copy: ["keys", "memory"] });
    expect(job).toMatchObject({ kind: "add", state: "running" });
    const [run] = c.spawned;
    expect(run?.command).toBe("/apps/localdot/bin/localdot");
    expect(run?.args).toEqual([
      "dots",
      "add",
      "Home",
      "--from",
      "main",
      "--copy",
      "keys,memory",
      "--json",
    ]);
    expect(run?.options.env).toEqual({
      HOME: "/Users/a",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LOCALDOT_HOME: c.main,
      XDG_CONFIG_HOME: expect.any(String),
    });
    expect(() => c.service.add({ name: "Other", copy: [] })).toThrow(DotsError);
    if (!run) throw new Error("not run");
    say(run.child, { step: "Copying keys", dot: "home" });
    say(run.child, { step: "Choose a passphrase", needs: "passphrase", sealKey: "k".repeat(87) });
    await settle();
    expect(c.service.job(job.id)).toMatchObject({
      state: "needs-passphrase",
      sealKey: "k".repeat(87),
      dot: "home",
    });
    const sealed = {
      v: 1 as const,
      epk: "e".repeat(87),
      nonce: "n".repeat(16),
      ct: "c".repeat(40),
    };
    expect(c.service.passphrase(job.id, sealed)).toMatchObject({ state: "running" });
    expect(JSON.parse(run.input.join(""))).toEqual({ sealed });
    expect(() => c.service.passphrase(job.id, sealed)).toThrow(DotsError);
    expect(() => c.service.cancel(job.id)).toThrow(DotsError);
    say(run.child, { done: true, dot: "home" });
    run.child.emit("close", 0);
    expect(c.service.job(job.id)).toEqual({
      id: job.id,
      kind: "add",
      state: "done",
      step: "Choose a passphrase",
      dot: "home",
    });
  });

  it("gives up on an add that waits for a passphrase by ending the command's input", async () => {
    const c = computer();
    const job = c.service.add({ name: "Home", copy: ["keys"] });
    const run = c.spawned[0];
    if (!run) throw new Error("not run");
    let ended = false;
    run.child.stdin.on("finish", () => {
      ended = true;
    });
    say(run.child, { step: "Choose a passphrase", needs: "passphrase", sealKey: "k".repeat(87) });
    await settle();
    expect(c.service.cancel(job.id)).toMatchObject({ state: "running", step: "Cancelling" });
    await settle();
    expect(ended).toBe(true);
    say(run.child, { error: "Adding Home was cancelled." });
    await settle();
    run.child.emit("close", 1);
    expect(c.service.job(job.id)).toMatchObject({
      state: "failed",
      error: "Adding Home was cancelled.",
    });
  });

  it("reports a failed command's own reason", async () => {
    const c = computer();
    const job = c.service.start("work");
    const run = c.spawned[0];
    if (!run) throw new Error("not run");
    expect(run.args).toEqual(["dots", "start", "work", "--json"]);
    say(run.child, { error: "Work didn't start. See its log." });
    await settle();
    run.child.emit("close", 1);
    expect(c.service.job(job.id)).toMatchObject({
      state: "failed",
      error: "Work didn't start. See its log.",
    });
    expect(() => c.service.start("nowhere")).toThrow("no such dot");
  });

  it("never stops or removes itself mid-request, and keeps the first dot", async () => {
    const c = computer();
    expect(() => c.service.stop("main")).toThrow(DotsError);
    await expect(c.service.remove("main", false, "http://127.0.0.1:4750")).rejects.toThrow(
      "The first dot stays",
    );
    expect(c.service.stop("work")).toMatchObject({ kind: "stop" });
    expect(c.spawned.at(-1)?.args).toEqual(["dots", "stop", "work", "--json"]);
  });

  it("removing the dot that answers first gives the browser a way back to the first dot", async () => {
    const c = computer("work");
    c.running.add(5750);
    const reply = await c.service.remove("work", true, "http://127.0.0.1:5750");
    expect(reply).toEqual({ next: `http://127.0.0.1:4750/#code=${CODE}` });
    c.running.delete(4750);
    expect(await c.service.remove("work", false, "http://127.0.0.1:5750")).toEqual({});
    const run = c.spawned[0];
    expect(run?.args).toEqual(["dots", "remove", "work", "--delete-data"]);
    expect(run?.options).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("signs in to another dot at the kind of address this browser uses", async () => {
    const c = computer();
    await expect(c.service.signIn("work", "http://127.0.0.1:4750")).rejects.toThrow(
      "Work isn't running",
    );
    c.running.add(5750);
    expect(await c.service.signIn("work", "http://127.0.0.1:4750")).toEqual({
      url: `http://127.0.0.1:5750/#code=${CODE}`,
    });
    expect(await c.service.signIn("work", "https://studio.example.ts.net:4750")).toEqual({
      url: `https://studio.example.ts.net:5750/#code=${CODE}`,
    });
    await expect(c.service.signIn("work", "https://elsewhere.example:4750")).rejects.toThrow(
      "can't be opened from this device",
    );
  });

  it("names the other dots that are busy, which an update would interrupt", async () => {
    const c = computer();
    c.running.add(5750);
    expect(await c.service.busyOthers()).toEqual([]);
    c.others.busy = true;
    expect(await c.service.busyOthers()).toEqual(["Work"]);
  });
});
