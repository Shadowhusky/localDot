import { constants } from "node:os";
import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { runDoctor } from "./doctor.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { parsePort } from "./port.ts";

// The first Ctrl-C lets the run finish, so the probe network it may have made is removed; a
// second one ends the doctor at once.
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) process.exit(128 + constants.signals[signal]);
    interrupted = signal;
  });
}

const socket = findDockerSocket();
const report = await runDoctor({
  docker: new DockerClient(socket.path),
  socket,
  images: imagesFromEnv(),
  port: parsePort(process.env.LOCALDOT_PORT),
});
for (const check of report.checks) {
  console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(24)} ${check.detail}`);
}
process.exit(interrupted ? 128 + constants.signals[interrupted] : report.ok ? 0 : 1);
