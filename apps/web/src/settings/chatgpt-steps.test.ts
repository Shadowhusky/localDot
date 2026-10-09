import { describe, expect, it } from "vitest";
import type { ChatgptSummary } from "./chatgpt-api.ts";
import { chatgptSteps } from "./chatgpt-steps.ts";

const summary = (patch: Partial<ChatgptSummary>): ChatgptSummary => ({
  available: true,
  codexVersion: "0.154.0",
  state: "unavailable",
  install: { state: "not_installed" },
  sandbox: "unchecked",
  ...patch,
});
const states = (value: ChatgptSummary, starting = false) =>
  chatgptSteps(value, starting).map((step) => step.state);
const ready = { state: "ready", version: "0.154.0" } as const;

describe("ChatGPT plan setup steps", () => {
  it("walks install, safety check and sign-in in order", () => {
    expect(states(summary({}))).toEqual(["todo", "todo", "todo"]);
    expect(states(summary({}), true)).toEqual(["doing", "todo", "todo"]);
    expect(
      states(summary({ install: { state: "downloading", receivedBytes: 1, totalBytes: 2 } })),
    ).toEqual(["doing", "todo", "todo"]);
    expect(states(summary({ install: ready, sandbox: "checking" }))).toEqual([
      "done",
      "doing",
      "todo",
    ]);
    expect(states(summary({ install: ready, sandbox: "passed", state: "signed_out" }))).toEqual([
      "done",
      "done",
      "ask",
    ]);
    expect(states(summary({ install: ready, sandbox: "passed", state: "signing_in" }))).toEqual([
      "done",
      "done",
      "doing",
    ]);
    expect(states(summary({ install: ready, sandbox: "passed", state: "signed_in" }))).toEqual([
      "done",
      "done",
      "done",
    ]);
  });
  it("shows the check running as soon as installation finishes", () => {
    expect(states(summary({ install: ready, sandbox: "unchecked" }))).toEqual([
      "done",
      "doing",
      "todo",
    ]);
  });
  it("names a failed step and keeps the next one waiting", () => {
    const failed = chatgptSteps(summary({ install: ready, sandbox: "failed" }), false);
    expect(failed.map((step) => step.state)).toEqual(["done", "failed", "todo"]);
    expect(failed[1]?.detail).toBe("Didn't pass, so ChatGPT stays off");
    const download = chatgptSteps(
      summary({ install: { state: "failed", code: "download_failed" } }),
      false,
    );
    expect(download[0]?.detail).toBe(
      "The download didn't finish. Check the connection and try again.",
    );
  });
  it("reports download progress in megabytes", () => {
    const [install] = chatgptSteps(
      summary({
        install: { state: "downloading", receivedBytes: 48_000_000, totalBytes: 116_501_639 },
      }),
      false,
    );
    expect(install?.detail).toBe("Downloading… 48.0 MB of 116.5 MB");
  });
});
