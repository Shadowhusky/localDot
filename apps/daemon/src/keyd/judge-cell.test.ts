import { describe, expect, it, vi } from "vitest";
import { JUDGE_CELL_ID, JudgeCell } from "./judge-cell.ts";

const SURROGATE = `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`;
const TOKEN = "t".repeat(43);

function cell(status = 200) {
  const keyd = {
    openCell: vi.fn(async (req: { cellId: string; port: number; secrets: string[] }) => ({
      cellId: req.cellId,
      port: req.port,
      proxyToken: TOKEN,
      caCertPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
      caPath: "/tmp/ca.pem",
      surrogates: { [req.secrets[0] ?? ""]: SURROGATE },
    })),
    closeCell: vi.fn(async () => true),
  };
  const ports = { reserve: vi.fn(() => 4789), release: vi.fn() };
  const fetch = vi.fn(
    async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
      new Response(JSON.stringify({ answers: {} }), { status }),
  );
  const judge = new JudgeCell({ keyd, ports, fetch: fetch as never });
  return { judge, keyd, ports, fetch };
}

describe("the judge's keyd listener", () => {
  it("opens one judge listener holding only the Jev key, and asks Jev with its stand-in", async () => {
    const c = cell();
    const body = { model: "jev-latest" };
    await c.judge.post("jev", body, new AbortController().signal);
    await c.judge.post("jev", body, new AbortController().signal);
    expect(c.keyd.openCell).toHaveBeenCalledOnce();
    expect(c.keyd.openCell).toHaveBeenCalledWith({
      cellId: JUDGE_CELL_ID,
      role: "judge",
      port: 4789,
      secrets: ["jev"],
    });
    const [url, init] = c.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.headers.authorization).toBe(`Bearer ${SURROGATE}`);
    expect(JSON.parse(init?.body ?? "")).toEqual(body);
    await c.judge.close();
    expect(c.ports.release).toHaveBeenCalledWith(4789);
  });

  it("drops a listener whose key was refused, so the next question opens a fresh one", async () => {
    const c = cell(403);
    await expect(c.judge.post("jev", {}, new AbortController().signal)).rejects.toThrow("403");
    expect(c.keyd.closeCell).toHaveBeenLastCalledWith(JUDGE_CELL_ID);
    expect(c.ports.release).toHaveBeenCalledWith(4789);
    await expect(c.judge.post("jev", {}, new AbortController().signal)).rejects.toThrow();
    expect(c.keyd.openCell).toHaveBeenCalledTimes(2);
  });

  it("gives the port back when keyd refuses to open the listener", async () => {
    const c = cell();
    c.keyd.openCell.mockRejectedValueOnce(new Error("no secret jev"));
    await expect(c.judge.post("jev", {}, new AbortController().signal)).rejects.toThrow();
    expect(c.ports.release).toHaveBeenCalledWith(4789);
  });
});
