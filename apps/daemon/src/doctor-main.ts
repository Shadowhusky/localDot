import { DockerClient } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { runDoctor } from "./doctor.ts";
import { findDockerSocket } from "./doctor-socket.ts";
import { parsePort } from "./port.ts";

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
process.exit(report.ok ? 0 : 1);
