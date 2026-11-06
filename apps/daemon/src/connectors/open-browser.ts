import { spawn } from "node:child_process";

const OPEN_MS = 10_000;

// Opens an https page in this computer's own browser, where the user's accounts are signed in.
// false: there is no browser here to open it in, as on a server.
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  start: typeof spawn = spawn,
): Promise<boolean> {
  if (!url.startsWith("https://")) return Promise.resolve(false);
  const command = platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = start(command, [url], { stdio: "ignore", timeout: OPEN_MS });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}
