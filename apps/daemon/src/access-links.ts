import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { configuredAccessOrigins, registerPublicOrigin } from "./guard.ts";

const exec = promisify(execFile);
const WINDOWS_TS = "/mnt/c/Program Files/Tailscale/tailscale.exe";
const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
export type AccessAddress = {
  origin: string;
  label: string;
  description: string;
  available?: boolean;
};
export function servedOrigins(status: unknown, serve: unknown, port: number): string[] {
  const s = status as { BackendState?: string; Self?: { DNSName?: string } };
  const config = serve as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    TCP?: Record<string, { HTTPS?: boolean }>;
    AllowFunnel?: Record<string, boolean>;
  };
  const name = s?.Self?.DNSName?.replace(/\.$/, "");
  if (s?.BackendState !== "Running" || !name || !/^[a-z0-9.-]+\.ts\.net$/.test(name)) return [];
  return Object.entries(config?.Web ?? {}).flatMap(([host, web]) => {
    const url = new URL(`https://${host}`);
    const target = web.Handlers?.["/"]?.Proxy;
    return url.hostname === name &&
      config.TCP?.[url.port || "443"]?.HTTPS === true &&
      !config.AllowFunnel?.[host] &&
      [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(target ?? "")
      ? [url.origin]
      : [];
  });
}
const privateIPv4 = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export class AccessLinks {
  private cached?: { at: number; value: { links: AccessAddress[]; tailscaleSetup: boolean } };
  private unregister: (() => void)[] = [];
  private pending?: Promise<{ links: AccessAddress[]; tailscaleSetup: boolean }>;
  constructor(private port: number) {}
  private executable() {
    if (existsSync(WINDOWS_TS)) return WINDOWS_TS;
    if (existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
      return "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    return "tailscale";
  }
  private async command(args: string[]) {
    return (await exec(this.executable(), args, { timeout: 5000, maxBuffer: 512 * 1024 })).stdout;
  }
  async read(force = false) {
    if (!force && this.cached && Date.now() - this.cached.at < 30_000) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.discover().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async discover() {
    let addresses = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && !n.internal && n.family === "IPv4")
      .map((n) => n?.address ?? "");
    let origins: string[] = [],
      tailscaleSetup = false;
    await Promise.all([
      (async () => {
        try {
          const status = JSON.parse(await this.command(["status", "--json"]));
          const serve = JSON.parse(await this.command(["serve", "status", "--json"]));
          origins = servedOrigins(status, serve, this.port);
          // Never replace somebody else's listener or silently enable a public Funnel.
          tailscaleSetup =
            status.BackendState === "Running" && !origins.length && !serve.TCP?.[String(this.port)];
        } catch {
          /* Tailscale is optional. */
        }
      })(),
      (async () => {
        if (!existsSync(POWERSHELL)) return;
        try {
          const { stdout } = await exec(
            POWERSHELL,
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Tailscale|Docker' } | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress",
            ],
            { timeout: 5000, maxBuffer: 8192 },
          );
          const value = JSON.parse(stdout);
          addresses = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        } catch {
          addresses = [];
        }
      })(),
    ]);
    for (const unregister of this.unregister) unregister();
    this.unregister = origins.map(registerPublicOrigin);
    const links: AccessAddress[] = [
      {
        origin: `http://localhost:${this.port}`,
        label: "This computer",
        description: "Works only on the computer running localDot.",
      },
      ...[...new Set([...configuredAccessOrigins(), ...origins])].map((origin) => ({
        origin,
        label: new URL(origin).hostname.endsWith(".ts.net") ? "Tailscale" : "Remote address",
        description:
          "Connect your other device to the same Tailscale network to use a Tailscale address.",
      })),
      ...[...new Set(addresses.filter(privateIPv4))].map((ip) => ({
        origin: `http://${ip}:${this.port}`,
        label: "Local network",
        available: false,
        description:
          "Network address detected, but LAN sharing is not enabled. Use Tailscale or turn on Remote access below to connect another device.",
      })),
    ];
    const value = { links, tailscaleSetup };
    this.cached = { at: Date.now(), value };
    return value;
  }
  async enableTailscale() {
    if (!(await this.read(true)).tailscaleSetup)
      throw new Error("Tailscale is unavailable or this port is already in use.");
    await this.command(["serve", "--bg", `--https=${this.port}`, `http://127.0.0.1:${this.port}`]);
    const result = await this.read(true);
    if (!result.links.some((l) => l.label === "Tailscale"))
      throw new Error("Finish enabling HTTPS in Tailscale, then try again.");
    return result;
  }
}
