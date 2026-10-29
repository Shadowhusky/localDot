import { accessSync, constants } from "node:fs";
import type { Exec } from "./services.ts";

export interface TailscalePort {
  // Serves 127.0.0.1:<port> to the tailnet at https://<name>:<port>, the way the installer serves
  // the first dot; never Funnel.
  serve(name: string, port: number): Promise<string>;
  off(port: number): Promise<void>;
}

const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// The source dot's tailnet name, when it is served through Tailscale: a new dot is served the same way.
export function tailnetName(publicOrigins: string | undefined): string | undefined {
  for (const origin of (publicOrigins ?? "").split(",")) {
    try {
      const url = new URL(origin.trim());
      if (url.protocol === "https:" && url.hostname.endsWith(".ts.net")) return url.hostname;
    } catch {}
  }
  return undefined;
}

export function tailscale(exec: Exec, path = process.env.PATH ?? ""): TailscalePort {
  const cli = () => {
    for (const dir of path.split(":").filter(Boolean)) {
      try {
        accessSync(`${dir}/tailscale`, constants.X_OK);
        return `${dir}/tailscale`;
      } catch {}
    }
    try {
      accessSync(APP_CLI, constants.X_OK);
      return APP_CLI;
    } catch {
      throw new Error(
        "Tailscale isn't installed here, so the new dot isn't served to your tailnet.",
      );
    }
  };
  return {
    async serve(name, port) {
      const result = await exec(cli(), [
        "serve",
        "--bg",
        `--https=${port}`,
        `http://127.0.0.1:${port}`,
      ]);
      if (result.code !== 0)
        throw new Error(
          "Tailscale Serve didn't start for the new dot. Check it with: tailscale serve status",
        );
      return `https://${name}:${port}`;
    },
    async off(port) {
      await exec(cli(), ["serve", `--https=${port}`, "off"]);
    },
  };
}
