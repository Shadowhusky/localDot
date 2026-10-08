import { type SeedOptions, seedSession } from "./recorder/testing/seed-session.ts";

try {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let video = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--no-video") {
      video = false;
      continue;
    }
    if (
      !["--home", "--minutes", "--title", "--marker", "--takeover", "--steps-per-minute"].includes(
        arg,
      ) ||
      values.has(arg) ||
      args[i + 1] === undefined ||
      args[i + 1]?.startsWith("--")
    )
      throw new RangeError("invalid seed arguments");
    values.set(arg, args[++i] as string);
  }
  const home = values.get("--home"),
    minutes = Number(values.get("--minutes"));
  if (!home || !values.has("--minutes")) throw new RangeError("home and minutes are required");
  const opts: SeedOptions = {
    home,
    minutes,
    stepsPerMinute: values.has("--steps-per-minute")
      ? Number(values.get("--steps-per-minute"))
      : undefined,
    video,
    title: values.get("--title"),
    marker: values.get("--marker"),
  };
  const span = values.get("--takeover");
  if (span !== undefined) {
    const match = /^(\d+)-(\d+)$/.exec(span);
    if (!match) throw new RangeError("invalid takeover span");
    opts.takeover = { fromMs: Number(match[1]), toMs: Number(match[2]) };
  }
  console.log(JSON.stringify(await seedSession(opts)));
} catch {
  console.error(
    "usage: seed --home <dir> --minutes <n> [--steps-per-minute <1..120>] [--title <text>] [--marker <text>] [--takeover <fromMs>-<toMs>] [--no-video]",
  );
  process.exitCode = 2;
}
