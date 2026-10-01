import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync: Run = promisify(execFile);

export interface Xsettings {
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface Screen {
  w: number;
  h: number;
}

// xfconf-query exits 1 for an unset property; unset means XFCE's default (1x, 96 dpi).
export async function xfconfInt(
  run: Run,
  channel: string,
  property: string,
): Promise<number | null> {
  try {
    const { stdout } = await run("xfconf-query", ["-c", channel, "-p", property]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function isRunning(run: Run, uid: number, name: string): Promise<boolean> {
  try {
    await run("pgrep", ["-u", String(uid), "-x", name]);
    return true;
  } catch {
    return false;
  }
}

// null: not known yet. xfconf-query D-Bus-activates an xfconfd when none runs, and one started
// before startwm.sh has written the HiDPI templates and exec'd xfce4-session would load the
// previous session's files and keep them for this session.
export async function readXsettings(
  uid: number,
  run: Run = execFileAsync,
): Promise<Xsettings | null> {
  if (!(await isRunning(run, uid, "xfce4-session")) || !(await isRunning(run, uid, "xfconfd"))) {
    return null;
  }
  return {
    windowScalingFactor: await xfconfInt(run, "xsettings", "/Gdk/WindowScalingFactor"),
    xftDpi: await xfconfInt(run, "xsettings", "/Xft/DPI"),
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
