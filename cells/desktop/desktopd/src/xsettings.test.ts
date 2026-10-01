import { describe, expect, it } from "vitest";
import { type Run, readXsettings } from "./xsettings.ts";

const UID = 911;
const SET = { "/Gdk/WindowScalingFactor": "2", "/Xft/DPI": "96" };

// pgrep finds only the processes in `running`; xfconf-query prints the properties in `set` and
// exits 1 for any other, as it does for an unset property.
function fakeRun(running: string[], set: Record<string, string>) {
  const calls: string[] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    const last = args.at(-1) ?? "";
    if (file === "pgrep" && running.includes(last)) return { stdout: "42\n" };
    const value = file === "xfconf-query" ? set[last] : undefined;
    if (value !== undefined) return { stdout: `${value}\n` };
    throw Object.assign(new Error(`${file} exited 1`), { code: 1 });
  };
  return { run, calls };
}

describe("readXsettings", () => {
  it("never runs xfconf-query, which would start an xfconfd, until the session's xfconfd runs", async () => {
    for (const running of [[], ["xfce4-session"], ["xfconfd"]]) {
      const { run, calls } = fakeRun(running, SET);
      expect(await readXsettings(UID, run), running.join()).toBeNull();
      expect(
        calls.filter((call) => call.startsWith("xfconf-query")),
        running.join(),
      ).toEqual([]);
    }
  });

  it("reads the session's live values once xfce4-session and xfconfd run", async () => {
    const { run, calls } = fakeRun(["xfce4-session", "xfconfd"], SET);
    expect(await readXsettings(UID, run)).toEqual({ windowScalingFactor: 2, xftDpi: 96 });
    expect(calls).toEqual([
      "pgrep -u 911 -x xfce4-session",
      "pgrep -u 911 -x xfconfd",
      "xfconf-query -c xsettings -p /Gdk/WindowScalingFactor",
      "xfconf-query -c xsettings -p /Xft/DPI",
    ]);
  });

  it("reads an unset property as null", async () => {
    const { run } = fakeRun(["xfce4-session", "xfconfd"], { "/Xft/DPI": "96" });
    expect(await readXsettings(UID, run)).toEqual({ windowScalingFactor: null, xftDpi: 96 });
  });
});
