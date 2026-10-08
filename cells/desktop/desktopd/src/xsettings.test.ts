import { describe, expect, it } from "vitest";
import { hidpiReport } from "./app.ts";
import { type Run, readXsettings } from "./xsettings.ts";

const UID = 911;
const SET = { "/Gdk/WindowScalingFactor": "2", "/Xft/DPI": "96" };
const SESSION = ["xfce4-session", "xfconfd"];

type Answer = () => Promise<{ stdout: string }>;

const failed = (fields: { code: number | null; stderr: string; killed?: boolean }) =>
  Object.assign(new Error("Command failed"), { stdout: "", ...fields });

// pgrep finds only the processes in `running`. xfconf-query answers as the real one does in the
// image: -p prints a set property's value or fails with exactly the "does not exist" line, and -l
// lists the channel's properties.
function fakeRun(running: string[], set: Record<string, string>) {
  const calls: string[] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "pgrep") {
      if (running.includes(args.at(-1) ?? "")) return { stdout: "42\n" };
      throw failed({ code: 1, stderr: "" });
    }
    if (args.includes("-l")) return { stdout: Object.keys(set).join("\n") };
    const property = args.at(-1) ?? "";
    const value = set[property];
    if (value !== undefined) return { stdout: `${value}\n` };
    throw failed({
      code: 1,
      stderr: `Property "${property}" does not exist on channel "xsettings".\n`,
    });
  };
  return { run, calls };
}

// Answers the one xfconf-query call with these arguments itself and passes the rest to `run`.
function intercept(run: Run, args: string, answer: Answer): Run {
  return (file, a) => (file === "xfconf-query" && a.join(" ") === args ? answer() : run(file, a));
}

describe("readXsettings", () => {
  it("never runs xfconf-query, which would start an xfconfd, before xfce4-session runs", async () => {
    for (const running of [[], ["xfconfd"]]) {
      const { run, calls } = fakeRun(running, SET);
      expect(await readXsettings(UID, run), running.join()).toBeNull();
      expect(
        calls.filter((call) => call.startsWith("xfconf-query")),
        running.join(),
      ).toEqual([]);
    }
  });

  it("reads the session's live values once xfce4-session runs", async () => {
    const { run, calls } = fakeRun(SESSION, SET);
    expect(await readXsettings(UID, run)).toEqual({ windowScalingFactor: 2, xftDpi: 96 });
    expect(calls).toEqual([
      "pgrep -u 911 -x xfce4-session",
      "xfconf-query -c xsettings -p /Gdk/WindowScalingFactor",
      "xfconf-query -c xsettings -p /Xft/DPI",
    ]);
  });

  // xfconfd exits after a while idle; reading then D-Bus-activates a fresh one, which loads the
  // session's saved files. Refusing here once marked a healthy computer failed after 30 idle minutes.
  it("wakes an xfconfd that went idle after the session started", async () => {
    const { run } = fakeRun(["xfce4-session"], SET);
    expect(await readXsettings(UID, run)).toEqual({ windowScalingFactor: 2, xftDpi: 96 });
  });

  it("reads an unset property as null once a listing of the channel confirms it", async () => {
    const { run, calls } = fakeRun(SESSION, { "/Xft/DPI": "96" });
    expect(await readXsettings(UID, run)).toEqual({ windowScalingFactor: null, xftDpi: 96 });
    expect(calls).toContain("xfconf-query -c xsettings -l");
  });

  it("reports not ready when a read fails any other way, so a failed read is never ok at 1x", async () => {
    const failures: [string, Answer][] = [
      [
        "no session bus",
        async () => {
          throw failed({
            code: 1,
            stderr: "Failed to init libxfconf: Could not connect: No such file or directory.\n",
          });
        },
      ],
      [
        "killed by the timeout",
        async () => {
          throw failed({ code: null, stderr: "", killed: true });
        },
      ],
      ["not a number", async () => ({ stdout: "one\n" })],
    ];
    for (const [label, answer] of failures) {
      const { run } = fakeRun(SESSION, { "/Gdk/WindowScalingFactor": "1", "/Xft/DPI": "96" });
      const read = intercept(run, "-c xsettings -p /Gdk/WindowScalingFactor", answer);
      const xsettings = await readXsettings(UID, read);
      expect(xsettings, label).toBeNull();
      expect(hidpiReport(1, xsettings).ok, label).toBe(false);
    }
  });

  // xfconf-query prints "does not exist" for a read that xfconfd dropped mid-call too, and a
  // listing that fails comes back empty.
  it("does not take a dropped read for an unset property", async () => {
    for (const [label, listing] of [
      ["an empty listing", ""],
      ["a listing that names the property", "/Gdk/WindowScalingFactor\n/Xft/DPI\n"],
    ] as const) {
      const { run } = fakeRun(SESSION, { "/Xft/DPI": "96" });
      const read = intercept(run, "-c xsettings -l", async () => ({ stdout: listing }));
      expect(await readXsettings(UID, read), label).toBeNull();
    }
  });
});
