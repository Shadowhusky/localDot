import { providerById } from "@localdot/providers";
import { describe, expect, it } from "vitest";
import { type SetupInput, setupSteps } from "./setup.ts";

const FRESH: SetupInput = {
  provider: null,
  key: null,
  modelReady: false,
  model: null,
  permissions: null,
  persona: null,
  computer: false,
};

describe("setup steps", () => {
  it("starts with nothing done and the model needed to start", () => {
    const { steps, done } = setupSteps(FRESH);
    expect(done).toBe(0);
    expect(steps.map((step) => step.title)).toEqual([
      "How dot thinks",
      "Key",
      "Model",
      "Permissions",
      "Your dot",
    ]);
    expect(steps.find((step) => step.id === "model")?.detail).toBe("Needed to start");
  });

  it("counts an API key and its provider before a model is chosen", () => {
    const { steps, done } = setupSteps({
      ...FRESH,
      provider: providerById("anthropic") ?? null,
      key: "anthropic-main",
    });
    expect(done).toBe(2);
    expect(steps.slice(0, 2).map((step) => step.detail)).toEqual(["API key", "anthropic-main"]);
  });

  it("needs no key for a local model and counts a computer already turned on", () => {
    const { steps, done } = setupSteps({
      ...FRESH,
      provider: providerById("ollama") ?? null,
      modelReady: true,
      model: "Ollama · qwen3",
      computer: true,
    });
    expect(steps[0]?.detail).toBe("Local model");
    expect(steps[1]).toMatchObject({ detail: "Not needed", done: true });
    expect(done).toBe(4);
  });

  it("calls a ChatGPT plan's credential a sign-in", () => {
    const { steps } = setupSteps({ ...FRESH, provider: "chatgpt" });
    expect(steps[0]?.detail).toBe("ChatGPT plan");
    expect(steps[1]).toMatchObject({ title: "Sign-in", detail: "Not signed in", done: false });
  });
});
