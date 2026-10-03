import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeydClient, KeydError } from "./client.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
});
async function fakeKeyd(reply: (req: IncomingMessage, body: string) => [number, unknown?]) {
  const home = mkdtempSync("/tmp/ldk-agent-");
  const socketPath = join(home, "admin.sock");
  const seen: { method: string; path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body });
      const [status, value] = reply(req, body);
      res.writeHead(status, value === undefined ? {} : { "content-type": "application/json" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  return { client: new KeydClient(socketPath), seen };
}
const model = {
  id: "fixture-model",
  inputUSDPerMTok: 1,
  outputUSDPerMTok: 2,
  maxOutputTokens: 4000,
};

describe("agent keyd adapters", () => {
  it("preserves omitted versus zero budget and stable task identity across cells", async () => {
    const { client, seen } = await fakeKeyd(() => [204]);
    await client.beginTask("brain-a", "task", 2.5);
    await client.beginTask("brain-b", "task");
    await client.beginTask("brain-c", "task", 0);
    await client.endTask("brain-c");
    expect(seen.map((r) => [r.method, r.path, r.body])).toEqual([
      ["PUT", "/v1/cells/brain-a/task", '{"taskId":"task","budgetUSD":2.5}'],
      ["PUT", "/v1/cells/brain-b/task", '{"taskId":"task"}'],
      ["PUT", "/v1/cells/brain-c/task", '{"taskId":"task","budgetUSD":0}'],
      ["DELETE", "/v1/cells/brain-c/task", ""],
    ]);
  });
  it("sends snapshot initialization distinctly from an explicit later ceiling raise", async () => {
    const { client, seen } = await fakeKeyd(() => [204]);
    const pricing = { v: 1 as const, routes: [{ route: "provider", models: [model] }] };
    await client.beginPricedTask("brain", "task", pricing, 5);
    await client.beginTask("brain", "task", 8);
    await client.beginPricedTask("replacement", "task", pricing, 5);
    expect(seen.map((x) => JSON.parse(x.body))).toEqual([
      { taskId: "task", pricing, budgetUSD: 5 },
      { taskId: "task", budgetUSD: 8 },
      { taskId: "task", pricing, budgetUSD: 5 },
    ]);
  });
  it("never silently drops an invalid budget into JSON null/default behavior", async () => {
    const { client, seen } = await fakeKeyd(() => [204]);
    for (const amount of [NaN, Infinity, -1, 10001])
      await expect(client.beginTask("c", "t", amount)).rejects.toThrow(RangeError);
    expect(() => client.setBudget(NaN, 10)).toThrow(RangeError);
    expect(() => client.setBudget(20, 10)).toThrow(RangeError);
    expect(seen).toEqual([]);
  });
  it("encodes identifiers and validates the returned route identity", async () => {
    const { client, seen } = await fakeKeyd(() => [
      200,
      { route: "provider/name", models: [model] },
    ]);
    expect(await client.routeModels("provider/name")).toEqual([model]);
    expect(seen[0]?.path).toBe("/v1/llm/routes/provider%2Fname/models");
    await expect(client.routeModels("different")).rejects.toMatchObject({ code: "bad-reply" });
  });
  it("handles nil models, whole-list replacement and budget replies", async () => {
    const budget = { perTaskUSD: 5, perDayUSD: 20, day: { date: "2026-10-03", spentUSD: 1.25 } };
    const { client, seen } = await fakeKeyd((req) =>
      req.url === "/v1/budget"
        ? [200, budget]
        : [200, { route: "provider", models: req.method === "GET" ? null : [model] }],
    );
    expect(await client.routeModels("provider")).toEqual([]);
    expect(await client.setRouteModels("provider", [model])).toEqual([model]);
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ models: [model] });
    expect(await client.budget()).toEqual(budget);
    expect(await client.setBudget(5, 20)).toEqual(budget);
    expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({ perTaskUSD: 5, perDayUSD: 20 });
  });
  it("keeps immutable conflicts and non-404 deletion errors visible", async () => {
    const { client } = await fakeKeyd((req) =>
      req.url?.includes("/absent/")
        ? [404]
        : [409, { error: { code: "task-pricing-conflict", message: "task policy differs" } }],
    );
    await expect(client.endTask("absent")).resolves.toBeUndefined();
    await expect(client.endTask("present")).rejects.toBeInstanceOf(KeydError);
    await expect(client.beginPricedTask("c", "t", { v: 1, routes: [] })).rejects.toMatchObject({
      status: 409,
      code: "task-pricing-conflict",
    });
  });
  it("rejects malformed successful replies instead of substituting defaults", async () => {
    const { client } = await fakeKeyd(() => [200, { models: "invalid" }]);
    await expect(client.routeModels("provider")).rejects.toMatchObject({ code: "bad-reply" });
    await expect(client.budget()).rejects.toMatchObject({ code: "bad-reply" });
  });
});
