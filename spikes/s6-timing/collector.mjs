import { createServer } from "node:http";

export const flips = [];
export function startCollector(port = 4795) {
  return createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { flips.push(JSON.parse(body)); res.end("ok"); });
      return;
    }
    res.end("ok");
  }).listen(port, "127.0.0.1");
}
