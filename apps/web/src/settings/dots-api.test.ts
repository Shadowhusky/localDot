// @vitest-environment jsdom
import type { DotJob } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { dotProblem, listDots, waitForJob } from "./dots-api.ts";

const job = (state: DotJob["state"], step?: string): DotJob => ({
  id: "a".repeat(22),
  kind: "add",
  state,
  ...(step ? { step } : {}),
});

function apiAnswering(answers: unknown[]): ApiClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async (path: string) => {
      asked.push(path);
      return answers.shift();
    },
  } as unknown as ApiClient & { asked: string[] };
}

describe("following a dot's job", () => {
  it("asks again only while it runs, and hands each step on", async () => {
    const api = apiAnswering([job("running", "Copying keys"), job("needs-passphrase")]);
    const steps: (string | undefined)[] = [];
    const sleep = vi.fn(async () => {});
    const settled = await waitForJob(api, job("running", "Making its folder"), {
      sleep,
      onUpdate: (next) => steps.push(next.step ?? next.state),
    });
    expect(settled.state).toBe("needs-passphrase");
    expect(steps).toEqual(["Copying keys", "needs-passphrase"]);
    expect(api.asked).toEqual([
      `/api/dots/jobs/${"a".repeat(22)}`,
      `/api/dots/jobs/${"a".repeat(22)}`,
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a finished job without asking", async () => {
    const api = apiAnswering([]);
    expect((await waitForJob(api, job("done"))).state).toBe("done");
    expect(api.asked).toEqual([]);
  });

  it("stops asking once the page lets go", async () => {
    const api = apiAnswering([job("running")]);
    const controller = new AbortController();
    controller.abort(new Error("closed"));
    await expect(waitForJob(api, job("running"), { signal: controller.signal })).rejects.toThrow(
      "closed",
    );
    expect(api.asked).toEqual([]);
  });

  it("refuses an answer it doesn't know", async () => {
    await expect(listDots(apiAnswering([{ dots: "many" }]))).rejects.toThrow(
      "localDot answered with something this page doesn't know.",
    );
  });
});

describe("what went wrong", () => {
  it("shows localDot's own words for a refusal, and a plain line for anything else", () => {
    expect(dotProblem(new ApiError(409, "Work isn't running."), "Couldn't open Work.")).toBe(
      "Work isn't running.",
    );
    expect(dotProblem(new ApiError(500, "Internal Server Error"), "Couldn't open Work.")).toBe(
      "Couldn't open Work.",
    );
    expect(dotProblem(new ApiError(401, "unauthorized"), "Couldn't open Work.")).toBe(
      "Couldn't open Work.",
    );
    expect(dotProblem(new TypeError("Failed to fetch"), "Couldn't open Work.")).toBe(
      "Couldn't open Work.",
    );
  });
});
