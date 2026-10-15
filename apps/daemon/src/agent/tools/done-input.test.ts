import { DoneInput, DoneModelInput } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolHarness } from "../testing/harness.ts";

const request = {
  question: "The real-data preview needs its WorkOS Client ID. What client ID should it use?",
  fields: [
    {
      id: "client_id",
      kind: "text",
      label: "WorkOS Client ID",
      hint: "The client_ identifier, not an API key or client secret.",
    },
  ],
  submit: "Continue verification",
  decline: "Skip verification",
};
const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function setup(options?: Parameters<typeof toolHarness>[0]) {
  const h = toolHarness(options);
  fixtures.push(h);
  return h;
}
async function pending(h: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(h.session.pendingAsk).toBeDefined());
  return h.session.pendingAsk as string;
}
const text = (result: { content: { text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("\n");

describe("completion waits for missing user input", () => {
  it("requires the model's input assessment while retaining old client compatibility", () => {
    const base = {
      summary: "Checked.",
      files: [],
      experience: null,
      completion: { status: "complete", evidence: "All requested checks passed" },
    };
    expect(DoneModelInput.safeParse(base).success).toBe(false);
    expect(DoneModelInput.safeParse({ ...base, input_request: null }).success).toBe(true);
    expect(DoneModelInput.safeParse({ ...base, input_request: request }).success).toBe(true);
    expect(DoneInput.safeParse({ summary: "Older client" }).success).toBe(true);
  });

  it("shows a form, waits, and returns the answer without a result/file/experience side effect", async () => {
    const h = setup();
    const hide = vi.fn(async () => {});
    h.tools.hideWork = hide;
    const save = vi.spyOn(h.tools, "saveOutput");
    const experience = vi.fn();
    h.tools.saveExperience = experience;
    const asking = h.call("done", {
      summary: "Other checks passed; UI needs configuration.",
      input_request: request,
      files: ["missing-result.txt"],
    });
    const id = await pending(h);
    expect(h.session.status).toBe("waiting_user");
    expect(h.events().find((e) => e.type === "ask.request")?.data).toMatchObject(request);
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
    expect(
      h.events().some((e) => e.type === "agent.state" && e.data.state === "waiting_user"),
    ).toBe(true);
    expect(h.session.answerFields(id, { client_id: "client_fixture_public_id" }, (s) => s)).toBe(
      true,
    );
    const answer = (await asking).body;
    expect(answer.ok).toBe(true);
    expect(answer.final).not.toBe(true);
    expect(text(answer)).toContain("client_fixture_public_id");
    expect(save).not.toHaveBeenCalled();
    expect(experience).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
    // The agent must do the remaining work, and only its later completion closes the task.
    const done = await h.call("done", {
      summary: "UI flow verified after configuration.",
      input_request: null,
      checked: "Form submitted and result visible",
    });
    expect(done.body).toMatchObject({ ok: true, final: true });
    expect(h.events().filter((e) => e.type === "task.result")).toHaveLength(1);
  });

  it("checks ask policy rather than treating the nested form as read-only completion", async () => {
    const decide = vi.fn(async (call: { tool: string }) =>
      call.tool === "ask_user"
        ? { kind: "deny" as const, reason: "Questions disabled for this test" }
        : { kind: "act" as const },
    );
    const h = setup({ policy: { decide } });
    const result = await h.call("done", { summary: "Need input", input_request: request });
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "ask_user", input: request }),
    );
    expect(result.body.ok).toBe(false);
    expect(result.body.final).not.toBe(true);
    expect(h.session.pendingAsk).toBeUndefined();
    expect(h.events().some((e) => e.type === "task.result" || e.type === "ask.request")).toBe(
      false,
    );
  });

  it("validates the entire form before asking, including unsupported secret field options", async () => {
    const h = setup();
    for (const fields of [
      [{ id: "client_id", kind: "text", label: "ID", target: [1, 2] }],
      [
        { id: "client_id", kind: "text", label: "ID" },
        { id: "client_id", kind: "text", label: "Again" },
      ],
    ]) {
      const result = await h.call("done", {
        summary: "Need input",
        input_request: { ...request, fields },
      });
      expect(result.status).toBe(400);
      expect(result.body.final).not.toBe(true);
    }
    expect(h.events().some((e) => e.type === "task.result" || e.type === "ask.request")).toBe(
      false,
    );
  });

  it("keeps private input guards instead of converting a secret to a text answer", async () => {
    const h = setup();
    const result = await h.call("done", {
      summary: "Need sign-in",
      input_request: {
        question: "Password",
        fields: [{ id: "password", kind: "secret", label: "Password" }],
      },
    });
    expect(result.body.ok).toBe(false);
    expect(result.body.final).not.toBe(true);
    expect(h.session.pendingAsk).toBeUndefined();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("honors a decline without pretending verification happened or asking again", async () => {
    const h = setup();
    const asking = h.call("done", { summary: "Need input", input_request: request });
    const id = await pending(h);
    expect(h.session.decline(id)).toBe(true);
    const result = (await asking).body;
    expect(result.final).not.toBe(true);
    expect(text(result)).toContain("Do not ask for this again");
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("returns an unanswered outcome at the configured timeout without recording completion", async () => {
    const h = setup({ askTimeoutMs: 25 });
    const result = (await h.call("done", { summary: "Need input", input_request: request })).body;
    expect(result.ok).toBe(false);
    expect(result.final).not.toBe(true);
    expect(text(result)).toContain("did not answer");
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("cancels the pending form on Stop without a late completion result", async () => {
    const h = setup();
    const asking = h.call("done", { summary: "Need input", input_request: request });
    const id = await pending(h);
    h.session.stop();
    await asking;
    expect(h.session.answerFields(id, { client_id: "late" }, (s) => s)).toBe(false);
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });
});
