import { execFile as nodeExecFile } from "node:child_process";

export type MacResult = "shown" | "failed" | "unavailable";
export interface MacNotifier {
  readonly available: boolean;
  show(title: string, body: string): Promise<MacResult>;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number },
  callback: (error: Error | null) => void,
) => void;

const OSASCRIPT = "/usr/bin/osascript";
// The text travels as run-handler arguments after "--", never inside the script: nothing in a
// task's title can become AppleScript, and a title that starts with "-" is not an option.
const SCRIPT = [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "-e",
  "end run",
  "--",
];
const PER_MINUTE = 6;

export function cleanLine(text: string, max: number): string {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// A banner from osascript has no click action and shows under Script Editor's notification
// settings.
export function macNotifier(
  opts: { platform?: NodeJS.Platform; execFile?: ExecFile; now?: () => number } = {},
): MacNotifier {
  const available = (opts.platform ?? process.platform) === "darwin";
  const run = opts.execFile ?? (nodeExecFile as unknown as ExecFile);
  const now = opts.now ?? Date.now;
  const recent: number[] = [];
  return {
    available,
    show(title, body) {
      if (!available) return Promise.resolve("unavailable");
      const at = now();
      while (recent.length && (recent[0] ?? 0) <= at - 60_000) recent.shift();
      if (recent.length >= PER_MINUTE) return Promise.resolve("failed");
      recent.push(at);
      const args = [...SCRIPT, cleanLine(title, 64) || "localDot", cleanLine(body, 160) || " "];
      return new Promise((resolve) => {
        run(
          OSASCRIPT,
          args,
          {
            timeout: 5_000,
            maxBuffer: 16 * 1024,
            env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "en_US.UTF-8" },
          },
          (error) => {
            if (error) console.error("a Mac notification could not be shown");
            resolve(error ? "failed" : "shown");
          },
        );
      });
    },
  };
}
