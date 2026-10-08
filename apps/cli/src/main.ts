import { constants } from "node:os";
import { runCli } from "./run.ts";
import { runtime } from "./runtime.ts";

declare const __LOCALDOT_VERSION__: string | undefined;
const controller = new AbortController();
const interrupt = (signal: NodeJS.Signals) => {
  if (controller.signal.aborted) process.exit(128 + constants.signals[signal]);
  controller.abort();
};
const onInt = () => interrupt("SIGINT"),
  onTerm = () => interrupt("SIGTERM");
process.on("SIGINT", onInt);
process.on("SIGTERM", onTerm);
try {
  process.exitCode = await runCli(
    {
      args: process.argv.slice(2),
      env: process.env,
      version: typeof __LOCALDOT_VERSION__ === "string" ? __LOCALDOT_VERSION__ : "development",
      signal: controller.signal,
    },
    { out: (message) => console.log(message), err: (message) => console.error(message) },
    runtime,
  );
} finally {
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
}
