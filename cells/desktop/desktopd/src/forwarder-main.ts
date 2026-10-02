import type { AddressInfo } from "node:net";
import {
  createForwarder,
  FORWARDER_PORT,
  GATE_PROXY_PORT,
  PROXY_TOKEN_FILE,
  readTokenFile,
} from "./forwarder.ts";

const gateHost = process.env.LOCALDOT_GATE_ADDR ?? "";
const gatePort = Number(process.env.LOCALDOT_GATE_PORT ?? GATE_PROXY_PORT);
const port = Number(process.env.LOCALDOT_FORWARDER_PORT ?? FORWARDER_PORT);
const tokenFile = process.env.LOCALDOT_PROXY_TOKEN_FILE ?? PROXY_TOKEN_FILE;

if (!gateHost) console.error("forwarder: LOCALDOT_GATE_ADDR is unset; every request gets 503");
const server = createForwarder({
  gate: gateHost ? { host: gateHost, port: gatePort } : undefined,
  readToken: () => readTokenFile(tokenFile),
});
// Loopback only: other containers can never reach a cell's loopback, so only this cell's own
// programs use the token the forwarder adds.
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  console.log(`forwarder on 127.0.0.1:${bound} -> ${gateHost || "(no gate)"}:${gatePort}`);
});
