import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileP = promisify(execFile);
// A wedged X server or xfconfd would otherwise leave a stuck child behind every /healthz poll.
const execFileAsync: Run = (file, args) =>
  execFileP(file, args, { timeout: 2_000, killSignal: "SIGKILL" });

export interface Xsettings {
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface Screen {
  w: number;
  h: number;
}

const DOES_NOT_EXIST = /^Property ".*" does not exist on channel ".*"\.\n?$/;

// null: unset, which means XFCE's default (1x, 96 dpi). xfconf-query fails with only the "does
// not exist" line for an unset property, but also for a read that xfconfd dropped mid-call; a
// listing of the channel comes back whole or empty, and the session's channel is never empty, so
// it tells the two apart. Any other failure throws: the value is not known.
export async function xfconfInt(
  run: Run,
  channel: string,
  property: string,
): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await run("xfconf-query", ["-c", channel, "-p", property]));
  } catch (err) {
    if (!doesNotExist(err)) throw err;
    const listed = await listProperties(run, channel);
    if (listed.length === 0 || listed.includes(property)) {
      throw new Error(`xfconf ${channel} ${property}: the read failed`);
    }
    return null;
  }
  const text = stdout.trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`xfconf ${channel} ${property}: not an integer`);
  return Number(text);
}

function doesNotExist(err: unknown): boolean {
  const { code, stderr } = err as { code?: unknown; stderr?: unknown };
  return code === 1 && typeof stderr === "string" && DOES_NOT_EXIST.test(stderr);
}

async function listProperties(run: Run, channel: string): Promise<string[]> {
  const { stdout } = await run("xfconf-query", ["-c", channel, "-l"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function isRunning(run: Run, uid: number, name: string): Promise<boolean> {
  try {
    await run("pgrep", ["-u", String(uid), "-x", name]);
    return true;
  } catch {
    return false;
  }
}

// null: not known yet, as when a read fails. xfconf-query D-Bus-activates an xfconfd when none
// runs, and one started before startwm.sh has written the HiDPI templates and exec'd
// xfce4-session would load the previous session's files and keep them for this session. Once
// xfce4-session runs the templates are in place, so waking an xfconfd that exited idle is safe.
export async function readXsettings(
  uid: number,
  run: Run = execFileAsync,
): Promise<Xsettings | null> {
  if (!(await isRunning(run, uid, "xfce4-session"))) return null;
  try {
    return {
      windowScalingFactor: await xfconfInt(run, "xsettings", "/Gdk/WindowScalingFactor"),
      xftDpi: await xfconfInt(run, "xsettings", "/Xft/DPI"),
    };
  } catch {
    return null;
  }
}

// The window scaling factor the hit tests map with. It changes only with the session's settings,
// and one read is three process spawns: it is read again at most every `ttlMs`. Unknown
// settings mean the cell's own scale.
export function windowScaling(
  read: () => Promise<Xsettings | null>,
  fallback: number,
  ttlMs = 5000,
  now: () => number = Date.now,
): () => Promise<number> {
  let kept: { at: number; value: Promise<number> } | undefined;
  return () => {
    if (!kept || now() - kept.at > ttlMs) {
      const value = read().then(
        (s) => (s === null ? fallback : (s.windowScalingFactor ?? 1)),
        () => fallback,
      );
      kept = { at: now(), value };
    }
    return kept.value;
  };
}

export async function readScreen(): Promise<Screen | null> {
  try {
    const { stdout } = await execFileAsync("xdpyinfo", []);
    const m = /dimensions:\s+(\d+)x(\d+)/.exec(stdout);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch {
    return null;
  }
}
