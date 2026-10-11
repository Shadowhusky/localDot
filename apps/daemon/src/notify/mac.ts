import { execFile as nodeExecFile } from "node:child_process";
import { join } from "node:path";
import { webDir } from "../static-ui.ts";

export type MacResult = "shown" | "failed" | "unavailable";
// This computer's own banner: macOS Notification Center, or a Linux desktop's notifications.
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

const PER_MINUTE = 6;

export function cleanLine(text: string, max: number): string {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// A real app bundle gives Notification Center its own localDot identity and mascot.
export function macNotifier(
  opts: {
    platform?: NodeJS.Platform;
    execFile?: ExecFile;
    now?: () => number;
    bundle?: string;
  } = {},
): MacNotifier {
  const bundle = opts.bundle ?? webDir("dist/native/localDot.app");
  const run = opts.execFile ?? (nodeExecFile as unknown as ExecFile);
  let registration: Promise<boolean> | undefined;
  const notifier = bannerCommand({
    available: (opts.platform ?? process.platform) === "darwin",
    file: join(bundle, "Contents/MacOS/localdot-notify"),
    args: (title, body) => [title, body],
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "en_US.UTF-8" },
    failure:
      "localDot notifications are unavailable; allow localDot in macOS System Settings > Notifications",
    timeout: 60_000, // First use may wait for the user's notification permission.
    ...opts,
  });
  return {
    available: notifier.available,
    async show(title, body) {
      if (!notifier.available) return "unavailable";
      registration ??= new Promise((resolve) => {
        run(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-f", bundle],
          {
            timeout: 5_000,
            maxBuffer: 16 * 1024,
            env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
          },
          (error) => resolve(!error),
        );
      });
      if (!(await registration)) {
        registration = undefined;
        return "failed";
      }
      return notifier.show(title, body);
    },
  };
}

// One program that shows a banner, at most PER_MINUTE a minute, its text as plain arguments.
export function bannerCommand(opts: {
  available: boolean;
  file: string;
  args: (title: string, body: string) => string[];
  env: NodeJS.ProcessEnv;
  failure: string;
  timeout?: number;
  execFile?: ExecFile;
  now?: () => number;
}): MacNotifier {
  const { available } = opts;
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
      const args = opts.args(cleanLine(title, 64) || "localDot", cleanLine(body, 160) || " ");
      return new Promise((resolve) => {
        run(
          opts.file,
          args,
          { timeout: opts.timeout ?? 5_000, maxBuffer: 16 * 1024, env: opts.env },
          (error) => {
            if (error) console.error(opts.failure);
            resolve(error ? "failed" : "shown");
          },
        );
      });
    },
  };
}
