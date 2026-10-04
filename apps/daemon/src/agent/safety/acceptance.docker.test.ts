import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AUTONOMY,
  ReplacementRecord,
  sealSecret,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assembledProcess } from "../../../../web/e2e/fixtures/assembled-process.ts";
import { KeydClient } from "../../keyd/client.ts";

const idResponse = z.object({ id: z.string().regex(ULID_PATTERN) });
const sessionResponse = z.object({ sessionId: z.string().regex(ULID_PATTERN) });
const ticketResponse = z.object({ path: z.string() });
const stopResponse = z.strictObject({
  revoked: z.boolean(),
  paused: z.boolean(),
  closed: z.boolean(),
  stopped: z.boolean(),
  errors: z.array(z.string()),
});
const enabled =
  process.env.LOCALDOT_ASSEMBLED_TESTS === "1" && process.env.LOCALDOT_SAFETY_TASK7_TESTS === "1";
async function until<T>(read: () => Promise<T | undefined>, timeout = 90000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Owned safety acceptance deadline exceeded.");
}
async function setup(name: string, scenario: "safety" | "recovery", failRetirement = false) {
  const output = process.env.LOCALDOT_SAFETY_ARTIFACTS;
  if (!output) throw new Error("An explicit private artifact directory is required.");
  const directory = join(output, name);
  mkdirSync(directory, { recursive: true });
  const f = await assembledProcess(
    { outputPath: (...paths) => join(directory, ...paths) },
    { pending: "shell", scenario, failRetirement },
  );
  const origin = new URL(f.url).origin,
    token = new URL(f.url).hash.slice("#token=".length);
  const request = (path: string, method = "GET", data?: unknown, signal?: AbortSignal) =>
    fetch(origin + path, {
      method,
      signal,
      headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  try {
    const keyd = new KeydClient(join(f.home, "keyd/admin.sock"));
    const binding = {
      id: "fixture",
      kind: "llm",
      provider: "openai-compatible",
      baseURL: "https://provider.example.test/v1",
    } as const;
    await keyd.putSecret(
      binding,
      await sealSecret((await keyd.status()).sealKey, binding, "task15-local-canary-never-real"),
    );
    const settings = await request("/api/agent/settings", "PUT", {
      main: {
        provider: "openai-compatible",
        model: "fixture-assembled-v1",
        key: "fixture",
        price: { inputUSDPerMTok: 1, outputUSDPerMTok: 1 },
      },
      taskBudgetUSD: 0.05,
      autonomy: DEFAULT_AUTONOMY,
    });
    expect(settings.status, await settings.text()).toBe(200);
    const created = await request("/api/cells", "POST", { scale: 1 });
    expect(created.status).toBe(202);
    const id = idResponse.parse(await created.json()).id;
    await until(async () => {
      const state = (await f.state()).find((x) => x.cell.id === id);
      if (state?.cell.state === "failed") throw new Error("Owned computer readiness failed.");
      return state?.cell.state === "ready" ? state : undefined;
    });
    const start = await request(`/api/cells/${id}/agent`, "POST", {
      task: "task14 synthetic acceptance. Local files and effects only.",
    });
    expect(start.status, await start.clone().text()).toBe(202);
    const owner = sessionResponse.parse(await start.json()).sessionId;
    const state = async () => (await f.state(owner)).find((x) => x.cell.id === id);
    const pending = () =>
      until(async () => {
        const s = await state();
        return s?.approval ?? undefined;
      }, 30000);
    const approve = async () => {
      const c = await pending();
      const body = {
        approvalId: c.approvalId,
        generation: c.generation,
        revision: c.revision,
        decision: "approve",
      };
      expect(
        (await request(`/api/agent/sessions/${owner}/approvals/answer`, "POST", body)).status,
      ).toBe(204);
      return body;
    };
    return { f, request, state, pending, approve, id, owner, directory };
  } catch (error) {
    await f.close();
    throw error;
  }
}

describe.skipIf(!enabled)("assembled safety routes with actual keyd and Docker effects", () => {
  it("a stale or reused public approval cannot create a second high-risk effect", async () => {
    const f = await setup("approval", "safety");
    try {
      await f.approve(); // synthetic HTML write, through the real public card
      const c = await f.pending();
      expect(c.actionClass).toBe("send");
      expect(c.risk).toBe("high");
      expect((await f.f.effects())[0]?.sendCount).toBe(0);
      const answer = {
        approvalId: c.approvalId,
        generation: c.generation,
        revision: c.revision,
        decision: "approve",
      };
      expect(
        (
          await f.request(`/api/agent/sessions/${f.owner}/approvals/answer`, "POST", {
            ...answer,
            revision: c.revision + 1,
          })
        ).status,
      ).toBe(409);
      expect((await f.f.effects())[0]?.sendCount).toBe(0);
      expect(
        (await f.request(`/api/agent/sessions/${f.owner}/approvals/answer`, "POST", answer)).status,
      ).toBe(204);
      await until(
        async () => ((await f.f.effects())[0]?.sendCount === 1 ? true : undefined),
        10000,
      );
      expect(
        (await f.request(`/api/agent/sessions/${f.owner}/approvals/answer`, "POST", answer)).status,
      ).toBe(409);
      expect((await f.f.effects())[0]?.sendCount).toBe(1);
      const stopped = await f.request(`/api/sessions/${f.owner}/stop`, "POST");
      expect(stopped.status).toBe(202);
      const outcome = stopResponse.parse(await stopped.json());
      expect(outcome.revoked).toBe(true);
      expect(outcome.paused || (outcome.closed && outcome.stopped)).toBe(true);
      writeFileSync(
        join(f.directory, "proof.json"),
        JSON.stringify(
          { actualEffectCount: 1, staleRefused: true, duplicateRefused: true, stop: outcome },
          null,
          2,
        ),
      );
    } finally {
      await f.f.close();
    }
  }, 120000);

  it("uncertain shell containment refuses the old owner, blocks failed retirement, then reconciles one fresh computer", async () => {
    const f = await setup("replacement", "recovery", true);
    try {
      const old = (await f.state())?.homeVolume;
      const ticketReply = await f.request(`/api/cells/${f.id}/stream-ticket`, "POST");
      expect(ticketReply.status).toBe(200);
      const oldPath = ticketResponse.parse(await ticketReply.json()).path;
      await f.approve();
      await until(
        async () =>
          (await f.state())?.events.some(
            (e) => e.type === "tool.output" && String(e.data.chunk).includes("task14 waiting"),
          )
            ? true
            : undefined,
        10000,
      );
      expect((await f.f.effects())[0]?.sendCount).toBe(1);
      const stop = await f.request(`/api/sessions/${f.owner}/stop`, "POST");
      expect(stop.status).toBe(202);
      const outcome = stopResponse.parse(await stop.json());
      expect(outcome.revoked).toBe(true);
      const fenced = await until(async () => {
        const s = await f.state();
        return s?.cell.fenced ? s : undefined;
      }, 30000);
      expect((await f.request(oldPath)).status).toBe(403);
      expect((await f.request(`/api/cells/${f.id}/start`, "POST")).status).toBe(409);
      expect(
        (
          await f.request(`/api/cells/${f.id}/agent`, "POST", {
            task: "task14 old owner must stay refused",
          })
        ).status,
      ).toBe(409);
      const revision = fenced.cell.fenced?.revision;
      if (!revision) throw new Error("The real containment fence is missing.");
      const blockedBody = { requestId: ulid(), oldRevision: revision, home: "fresh" };
      const blockedReply = await f.request(`/api/cells/${f.id}/replacement`, "POST", blockedBody);
      expect(blockedReply.status).toBe(200);
      const blocked = ReplacementRecord.parse(await blockedReply.json());
      expect(blocked).toMatchObject({ phase: "blocked", reason: "old_retirement" });
      expect(blocked.newCellId).toBeUndefined();
      expect(await f.f.state()).toHaveLength(1);
      const body = { requestId: ulid(), oldRevision: revision, home: "fresh" };
      // This backend case discards the accepted response and recovers via matching GET.
      // The browser acceptance case separately aborts delivery after the server commits.
      const accepted = await f.request(`/api/cells/${f.id}/replacement`, "POST", body);
      expect(accepted.status).toBe(200);
      await accepted.body?.cancel();
      const ready = await until(async () => {
        const reply = await f.request(`/api/cells/${f.id}/replacement/${body.requestId}`);
        expect(reply.status).toBe(200);
        const value = ReplacementRecord.parse(await reply.json());
        return value.phase === "ready" ? value : undefined;
      }, 60000);
      expect(ready.newCellId).not.toBe(f.id);
      const fresh = (await f.f.state()).find((x) => x.cell.id === ready.newCellId);
      expect(fresh?.cell).toMatchObject({ state: "ready" });
      expect(fresh?.cell.replacementPending).toBeUndefined();
      expect(fresh?.homeVolume).not.toBe(old);
      expect((await f.f.effects()).find((x) => x.cellId === ready.newCellId)).toMatchObject({
        sendCount: 0,
        atomicWritten: false,
      });
      expect((await f.request(`/api/cells/${f.id}/replacement`, "POST", body)).status).toBe(200);
      expect(await f.f.state()).toHaveLength(2);
      const newTicket = await f.request(`/api/cells/${ready.newCellId}/stream-ticket`, "POST");
      expect(newTicket.status).toBe(200);
      expect(ticketResponse.parse(await newTicket.json()).path).not.toBe(oldPath);
      expect((await f.request(oldPath)).status).toBe(403);
      expect((await f.state())?.provider).toHaveLength(1);
      writeFileSync(
        join(f.directory, "proof.json"),
        JSON.stringify(
          {
            oldOwnerRefused: true,
            oldTicket403: true,
            blockedWithoutAllocation: blocked,
            postResponseDiscarded: true,
            recoveredByMatchingGet: true,
            reconciled: ready,
            freshHome: true,
            originalRequestNeverRecreated: true,
            providerRequests: 1,
          },
          null,
          2,
        ),
      );
    } finally {
      await f.f.close();
    }
  }, 180000);
});
