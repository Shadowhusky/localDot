import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4799);
const host = process.argv[3] ?? "127.0.0.1";
createServer((_req, res) => res.end("host-ok\n")).listen(port, host, () => {
  console.log(`host listener on ${host}:${port}`);
});
