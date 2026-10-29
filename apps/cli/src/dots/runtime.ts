import { createInterface } from "node:readline";
import { MAIN_DOT_ID } from "../../../../packages/protocol/src/dots.ts";
import { DockerClient } from "../../../daemon/src/cells/docker.ts";
import { findDockerSocket } from "../../../daemon/src/doctor-socket.ts";
import { formatRange } from "../../../daemon/src/dots/instance.ts";
import { DotsRegistry, registryPath } from "../../../daemon/src/dots/registry.ts";
import { KeydClient, keydSocketPath } from "../../../daemon/src/keyd/client.ts";
import { runOpenLink } from "../../../daemon/src/open-link.ts";
import type { DotsCommand } from "../args.ts";
import { hasInstallState } from "../install/initialize-home.ts";
import type { CommandContextInput, ConsoleIO } from "../runtime.ts";
import { runStopComputers } from "../stop-computers.ts";
import { terminalPrompt } from "../unlock.ts";
import {
  addDot,
  type DotsDeps,
  type DotsIO,
  dotEnvironmentLines,
  listDots,
  openInBrowser,
  refreshDots,
  removeDot,
  resolveDot,
  setDotsLogin,
  startDot,
  uninstallDots,
} from "./commands.ts";
import { exec, hostServices } from "./services.ts";
import { tailscale } from "./tailscale.ts";

async function answering(port: number): Promise<boolean> {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    return reply.ok && (await reply.text()) === "ok";
  } catch {
    return false;
  }
}

async function hostDeps(input: CommandContextInput, json: boolean): Promise<DotsDeps> {
  const env = input.env;
  return {
    env,
    signal: input.signal,
    registry: new DotsRegistry(registryPath(env), input.home),
    services: hostServices(process.platform, env),
    managed: await hasInstallState(input.home).catch(() => false),
    // A copy between two Keychains takes a helper run per key on each side.
    keyd: (home) => new KeydClient(keydSocketPath(home), 300_000),
    docker: () => new DockerClient(findDockerSocket(env).path),
    running: answering,
    stopComputers: async (home, port) =>
      (await runStopComputers(
        { home, port, env, signal: input.signal },
        { out: () => {}, err: () => {} },
      )) === 0,
    tailscale: tailscale(exec, env.PATH),
    ...(json
      ? { answers: createInterface({ input: process.stdin })[Symbol.asyncIterator]() }
      : process.stdin.isTTY
        ? { prompt: terminalPrompt() }
        : {}),
    async signInLink(home, port) {
      let link: string | undefined;
      const code = await runOpenLink(
        { home, port, signal: input.signal },
        { out: (line) => (link ??= line), err: () => {} },
      );
      return code === 0 ? link : undefined;
    },
    openBrowser: (link) => openInBrowser(link, env),
  };
}

export async function runDots(
  input: CommandContextInput,
  command: DotsCommand,
  io: ConsoleIO,
): Promise<number> {
  const json = "json" in command && command.json === true;
  const out: DotsIO = { ...io, json };
  const deps = await hostDeps(input, json);
  try {
    switch (command.operation) {
      case "list":
        await listDots(deps, out);
        break;
      case "add":
        await addDot(deps, out, command);
        break;
      case "remove":
        await removeDot(deps, out, { dot: command.dot, deleteData: !!command.deleteData });
        break;
      case "start":
      case "stop":
        await startDot(deps, out, command.dot, command.operation === "start");
        break;
      case "env":
        for (const line of dotEnvironmentLines(deps, command.dot)) io.out(line);
        break;
      case "refresh":
        await refreshDots(deps, out);
        break;
      case "login":
        await setDotsLogin(deps, command.on);
        break;
      case "uninstall":
        await uninstallDots(deps, out);
        break;
    }
    return 0;
  } catch (error) {
    if (!json) throw error;
    io.out(JSON.stringify({ error: (error as Error).message }));
    return 1;
  } finally {
    if (json) process.stdin.destroy();
  }
}

// The environment that points the usual commands at one dot: its folder, port and keys' ports.
export async function dotEnvironment(
  input: CommandContextInput,
  wanted: string,
): Promise<NodeJS.ProcessEnv> {
  const dot = resolveDot(await hostDeps(input, false), wanted);
  return {
    LOCALDOT_HOME: dot.home,
    LOCALDOT_PORT: String(dot.instance.ports.app),
    LOCALDOT_KEYD_PORTS: formatRange(dot.instance.ports.keyd),
    ...(dot.id === MAIN_DOT_ID
      ? {}
      : { LOCALDOT_PUBLIC_ORIGIN: (dot.instance.publicOrigins ?? []).join(",") }),
  };
}
