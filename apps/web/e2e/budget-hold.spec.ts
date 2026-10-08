import { ulid } from "@localdot/protocol";
import { expect, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

// The fixture answers a Resume held at the shared daily limit as the daemon does: it tries the
// refused model call again, so the task runs instead of falling back to its budget pause.
let fixture: UiFixture;
test.beforeAll(async () => {
  fixture = await startUiFixture({ QA_SCENARIO: "running" }, "localdot-budget-hold");
});
test.afterAll(() => fixture?.close());

test("a Resume held at the daily limit retries the refused call", async ({ request }) => {
  const headers = { authorization: `Bearer ${TOKEN}`, origin: fixture.origin };
  const task = `${fixture.origin}/api/agent/sessions/${fixture.sessionId}`;
  expect((await request.post(`${fixture.origin}/__qa/budget?scope=day`, { headers })).ok()).toBe(
    true,
  );
  const paused = await request.post(`${task}/pause`, { headers, data: { requestId: ulid() } });
  expect(paused.status()).toBe(202);
  const pause = await paused.json();
  expect((await (await request.get(task, { headers })).json()).budgetHold).toBe("day");
  const resumed = await request.post(`${task}/resume`, {
    headers,
    data: { requestId: pause.requestId, revision: pause.revision },
  });
  expect(resumed.status()).toBe(204);
  const snapshot = await (await request.get(task, { headers })).json();
  expect(snapshot.budgetHold).toBeUndefined();
  expect(snapshot.status).toBe("running");
});
