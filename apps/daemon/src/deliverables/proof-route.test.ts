import { ProofReply, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { cleanFixtures, deliverablesFixture } from "./testing/fixture.ts";

afterEach(cleanFixtures);
describe("proof route", () => {
  it("gives a seeded task with a recording three proof frames and its check", async () => {
    const f = deliverablesFixture();
    const seed = await seedSession({
      home: f.home,
      minutes: 1,
      stepsPerMinute: 8,
      title: "Seeded proof",
    });
    const id = seed.sessionId;
    f.log.append(id, {
      type: "step.verify",
      agent: "main",
      data: { status: "success", evidence: "opens, 4 sheets" },
    });
    f.log.append(id, { type: "task.result", agent: "main", data: { summary: "s", files: [] } });
    const reply = ProofReply.parse(await (await f.get(`/api/agent/sessions/${id}/proof`)).json());
    const proof = reply.results[0];
    expect(reply.recording).toBe("complete");
    expect(proof?.frames.map((x) => x.role)).toEqual(["start", "change", "end"]);
    expect(new Set(proof?.frames.map((x) => x.frameId)).size).toBe(3);
    expect(proof?.checked).toBe("opens, 4 sheets");
  }, 30_000);
  it("answers an unknown task with 404", async () => {
    const f = deliverablesFixture();
    expect((await f.get(`/api/agent/sessions/${ulid()}/proof`)).status).toBe(404);
  });
});
