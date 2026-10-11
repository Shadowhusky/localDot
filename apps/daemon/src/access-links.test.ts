import { expect, it } from "vitest";
import { servedOrigins } from "./access-links.ts";

const status = { BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } };
const serve = (proxy = "http://127.0.0.1:4750") => ({
  TCP: { "4750": { HTTPS: true } },
  Web: { "pc.example.ts.net:4750": { Handlers: { "/": { Proxy: proxy } } } },
});
it("discovers only HTTPS routes to this app on the connected machine", () => {
  expect(servedOrigins(status, serve(), 4750)).toEqual(["https://pc.example.ts.net:4750"]);
  expect(servedOrigins(status, serve("http://127.0.0.1:8000"), 4750)).toEqual([]);
  expect(servedOrigins({ ...status, BackendState: "Stopped" }, serve(), 4750)).toEqual([]);
  expect(
    servedOrigins(status, { ...serve(), AllowFunnel: { "pc.example.ts.net:4750": true } }, 4750),
  ).toEqual([]);
  expect(servedOrigins(status, { ...serve(), TCP: { "4750": { HTTPS: false } } }, 4750)).toEqual(
    [],
  );
});
