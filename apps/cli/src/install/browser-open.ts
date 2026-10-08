import { spawn } from "node:child_process";

/** Accept only URLs constructed by the local installer/link issuer, never arbitrary schemes,
 * hosts, credentials, paths or command-line arguments supplied by a service response. */
export function isInstallerBrowserURL(value: string): boolean {
  const match =
    /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/(?:#code=[A-Za-z0-9_-]{43}|#progress=[A-Za-z0-9_-]{43})$/.exec(
      value,
    );
  return (
    !!match &&
    match[0] === value &&
    String(Number(match[1])) === match[1] &&
    Number(match[1]) >= 1024 &&
    Number(match[1]) <= 65535
  );
}

export async function openInstallerBrowser(url: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || process.platform !== "darwin" || !isInstallerBrowserURL(url)) return false;
  return new Promise<boolean>((resolve) => {
    // /usr/bin/open returns after handing off the URL; it does not own the browser process.
    const child = spawn("/usr/bin/open", [url], {
      shell: false,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 5_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(!failed && !signal.aborted && code === 0);
    });
  });
}
