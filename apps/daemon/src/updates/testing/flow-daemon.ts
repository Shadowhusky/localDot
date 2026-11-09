// A daemon of nothing but the real updater and its routes, for the install-level update test
// (scripts/distribution/update-flow.test.ts). Bundled into a test package; never shipped.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { installImageClient } from "../../../../cli/src/install/image-client.ts";
import { prepareImages } from "../../../../cli/src/install/prepare-images.ts";
import { freeBytes } from "../../recorder/disk.ts";
import { imageSocket, packageAppUpdater } from "../package-updater.ts";
import { appUpdateRoutes } from "../routes.ts";

const home = process.env.LOCALDOT_HOME ?? "";
const prefix = process.env.LOCALDOT_INSTALL_PREFIX ?? "";
const control = join(process.env.HOME ?? "", "control");
const version = JSON.parse(readFileSync("package-release.json", "utf8")).version;
const read = (name: string) => {
  const path = join(control, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
};
if (read("crash-version") === version) {
  console.error("Injected crash on start.");
  process.exit(70);
}
const updater = await packageAppUpdater(
  home,
  prefix,
  () => read("busy"),
  () => {},
  {
    exec: promisify(execFile),
    spawn,
    // The installer's own service handling is under test; a transient systemd unit is not.
    platform: "darwin",
    freeBytes,
    images: (pins, signal, report) =>
      prepareImages(
        pins,
        installImageClient(imageSocket(), "arm64", { anyEngine: true }),
        signal,
        report,
      ),
  },
);
const app = new Hono();
app.get("/", (c) => c.text("localDot"));
app.get("/healthz", (c) => c.text("ok"));
appUpdateRoutes(app, updater);
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.LOCALDOT_PORT),
  hostname: "127.0.0.1",
});
const stop = () => {
  server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
