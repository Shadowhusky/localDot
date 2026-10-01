import { userInfo } from "node:os";
import { serve } from "@hono/node-server";
import { createDesktopdApp } from "./app.ts";
import { MIN_TOKEN_LENGTH } from "./auth.ts";
import { readScreen, readXsettings } from "./xsettings.ts";

const token = process.env.LOCALDOT_DESKTOPD_TOKEN ?? "";
if (token.length < MIN_TOKEN_LENGTH) {
  console.error(
    `desktopd: LOCALDOT_DESKTOPD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
  );
  process.exit(1);
}
const scale = process.env.LOCALDOT_SCALE === "1" ? 1 : 2;
const port = Number(process.env.LOCALDOT_DESKTOPD_PORT ?? 7700);
// desktopd runs as the session's user, so its own uid is the session's.
const uid = userInfo().uid;
const app = createDesktopdApp({
  token,
  scale,
  display: process.env.DISPLAY ?? ":1",
  readXsettings: () => readXsettings(uid),
  readScreen,
});
// 0.0.0.0 inside the cell: only the gate's relay on the isolated internal network can reach it.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`desktopd on 0.0.0.0:${port} (scale ${scale})`);
});
