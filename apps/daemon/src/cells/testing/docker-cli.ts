import { execFileSync, spawnSync } from "node:child_process";

export const DOCKER_TESTS = process.env.LOCALDOT_DOCKER_TESTS === "1";

export function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function dockerOk(...args: string[]): boolean {
  return spawnSync("docker", args, { stdio: "ignore" }).status === 0;
}

export function dockerExec(container: string, ...cmd: string[]): { status: number; out: string } {
  const r = spawnSync("docker", ["exec", container, ...cmd], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function dockerExecAs(
  container: string,
  user: string,
  ...cmd: string[]
): { status: number; out: string } {
  const r = spawnSync("docker", ["exec", "-u", user, container, ...cmd], { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// `docker logs` keeps the container's two streams apart, and Selkies logs to stderr.
export function dockerLogs(container: string): string {
  const r = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker logs ${container} exited ${r.status}: ${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

export function publishedPort(container: string, port: string): number {
  // docker port prints "127.0.0.1:55123" (one line per address family).
  const line = docker("port", container, port).split("\n")[0] ?? "";
  const host = Number(line.split(":").at(-1));
  if (!Number.isInteger(host) || host <= 0) {
    throw new Error(`no published port for ${port}: ${line}`);
  }
  return host;
}

export function subnetOf(network: string): string {
  return docker("network", "inspect", "-f", "{{(index .IPAM.Config 0).Subnet}}", network);
}

// -v also removes anonymous volumes, such as the one an image's VOLUME line creates on every run.
export function removeAll(names: {
  containers?: string[];
  networks?: string[];
  volumes?: string[];
}) {
  for (const c of names.containers ?? []) {
    spawnSync("docker", ["rm", "-fv", c], { stdio: "ignore" });
  }
  for (const n of names.networks ?? []) {
    spawnSync("docker", ["network", "rm", n], { stdio: "ignore" });
  }
  for (const v of names.volumes ?? []) {
    spawnSync("docker", ["volume", "rm", "-f", v], { stdio: "ignore" });
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitFor(label: string, pred: () => boolean, ms: number, everyMs = 1000): void {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    sleepSync(everyMs);
  }
}
