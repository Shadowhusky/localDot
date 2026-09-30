import { createServer } from "node:http";
import httpProxy from "http-proxy";

const proxy = httpProxy.createProxyServer({
  target: "https://127.0.0.1:4791",
  secure: false,
  ws: true,
  changeOrigin: true,
});
proxy.on("error", (err) => console.error("proxy error:", err.message));
const server = createServer((req, res) => proxy.web(req, res));
server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));
server.listen(4792, "127.0.0.1", () => console.log("proxy on http://127.0.0.1:4792"));
