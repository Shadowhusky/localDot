import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BrowserEngineRefusal } from "../cells/browser-engine.ts";
import { browserEngineRoutes } from "./engine-routes.ts";

const STATUS = {
  engine: "chromium",
  choice: null,
  offered: true,
  builtIn: false,
  installing: false,
  restartNeeded: false,
};

function fixture() {
  const deps = {
    engineStatus: vi.fn(async () => STATUS),
    chooseEngine: vi.fn(async () => {}),
    restoreEngineBackup: vi.fn(async () => {}),
    dropEngineBackup: vi.fn(async () => {}),
  };
  const app = new Hono();
  browserEngineRoutes(app, deps as never);
  const put = (body: unknown) =>
    app.request("/api/browser/engine", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, deps, put };
}

describe("choosing the web browser over the API", () => {
  it("reports the status", async () => {
    const { app } = fixture();
    const reply = await app.request("/api/browser/engine");
    expect(await reply.json()).toEqual(STATUS);
  });

  it("won't take Chrome without an explicit acceptance of Google's terms", async () => {
    const { put, deps } = fixture();
    for (const body of [
      { choice: "chrome" },
      { choice: "chrome", acceptGoogleTerms: false },
      { choice: "firefox", acceptGoogleTerms: true },
      {},
    ])
      expect((await put(body)).status).toBe(400);
    expect(deps.chooseEngine).not.toHaveBeenCalled();
    expect((await put({ choice: "chrome", acceptGoogleTerms: true })).status).toBe(200);
    expect(deps.chooseEngine).toHaveBeenCalledOnce();
  });

  it("takes Chromium with nothing to accept", async () => {
    const { put, deps } = fixture();
    expect((await put({ choice: "chromium" })).status).toBe(200);
    expect(deps.chooseEngine).toHaveBeenCalledWith({ choice: "chromium" });
  });

  it("passes on the reason when the choice can't be made yet", async () => {
    const { put, deps } = fixture();
    deps.chooseEngine.mockRejectedValueOnce(new BrowserEngineRefusal("Go back to the backup."));
    const reply = await put({ choice: "chromium" });
    expect(reply.status).toBe(409);
    expect(await reply.text()).toBe("Go back to the backup.");
  });

  it("says when the backup couldn't be restored", async () => {
    const { app, deps } = fixture();
    deps.restoreEngineBackup.mockRejectedValueOnce(new Error("There is no backup to restore"));
    const reply = await app.request("/api/browser/engine/restore", { method: "POST" });
    expect(reply.status).toBe(409);
    expect(await reply.text()).toBe("There is no backup to restore");
  });

  it("deletes the backup", async () => {
    const { app, deps } = fixture();
    const reply = await app.request("/api/browser/engine/backup", { method: "DELETE" });
    expect(reply.status).toBe(200);
    expect(deps.dropEngineBackup).toHaveBeenCalledOnce();
  });
});
